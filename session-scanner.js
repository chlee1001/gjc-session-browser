import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const MAX_SEARCH_TEXT = 32_000;
const MAX_EXCHANGE_TEXT = 4_000;
const HEADER_READ_BYTES = 16_384;
const TRANSCRIPT_SUFFIX = '.jsonl';
const DISCOVERY_CONCURRENCY = 32;
const INDEX_CONCURRENCY = 12;
const TRANSCRIPT_CONCURRENCY = 4;

async function mapConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/**
 * GJC는 세션 파일 `<name>.jsonl` 옆에 같은 이름의 디렉터리를 만들어 그 세션의
 * 아티팩트와 서브에이전트 전사본을 담는다. 그 안의 .jsonl은 독립 세션이
 * 아니므로 목록 탐색에서는 트리째 건너뛴다. 넣으면 목록이 서브에이전트 기록으로
 * 뒤덮이고, 삭제도 실패한다 — GJC의 관리 세션 삭제는 `<저장소>/<폴더>/<파일>`
 * 배치를 전제한다. 단, 그 안의 토큰과 비용은 부모 세션이 쓴 몫이라 사용량에는 합산한다.
 */
async function isArtifactDirectory(directoryPath) {
  try {
    const sibling = await stat(`${directoryPath}.jsonl`);
    return sibling.isFile();
  } catch {
    return false;
  }
}

async function findSessionFiles(directories) {
  const files = [];
  const pending = directories.filter(Boolean);

  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!await isArtifactDirectory(fullPath)) pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/** 세션이 부린 서브에이전트 전사본. 서브에이전트가 또 서브에이전트를 부르면 중첩되므로 끝까지 내려간다. */
async function collectTranscripts(directory, found = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectTranscripts(fullPath, found);
    else if (entry.isFile() && entry.name.endsWith(TRANSCRIPT_SUFFIX)) found.push(fullPath);
  }

  return found;
}

function artifactDirectoryFor(sessionFilePath) {
  return sessionFilePath.slice(0, -TRANSCRIPT_SUFFIX.length);
}

/**
 * 전사본 묶음의 지문. 세션 파일만 보면 서브에이전트 쪽만 바뀔 때 캐시가 안 넘어간다.
 * 개수·총 크기·최신 mtime이 같으면 다시 읽지 않는다.
 */
async function transcriptFingerprint(transcripts) {
  let size = 0;
  let mtimeMs = 0;

  for (const transcript of transcripts) {
    try {
      const fileStat = await stat(transcript);
      size += fileStat.size;
      mtimeMs = Math.max(mtimeMs, fileStat.mtimeMs);
    } catch {
      // 읽지 못한 전사본은 지문에서 뺀다.
    }
  }

  return `${transcripts.length}:${size}:${mtimeMs}`;
}

async function* readEntries(filePath) {
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    yield entry;
  }
}

/** Fold one entry into the running header state; `header_patch` overrides the original session line. */
function applyHeaderEntry(header, entry) {
  if (entry.type === 'session') header.session = entry;
  else if (entry.type === 'model_change' && entry.model) header.model = entry.model;
  else if (entry.type === 'header_patch' && header.session && entry.patch) {
    if (typeof entry.patch.title === 'string') header.session.title = entry.patch.title;
    if (typeof entry.patch.cwd === 'string') header.session.cwd = entry.patch.cwd;
  }
}

/**
 * 한 세션이 도중에 모델을 갈아탄다. 사용량을 세션 헤더의 모델로 몰아 주면
 * 마지막 모델이 앞선 모델의 토큰까지 가져간다. 그래서 응답 메시지에 적힌 모델로
 * 나눠 담는다. 메시지는 provider와 model을 따로 들고 오므로 model_change가 쓰는
 * `vendor/name` 표기로 합쳐 두 출처가 같은 이름 공간을 쓰게 한다.
 */
function messageModelId(message, fallback) {
  if (!message.model) return fallback;
  return message.provider ? `${message.provider}/${message.model}` : message.model;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function sessionResult(session, filePath, fileStat, values = {}) {
  const cwd = session.cwd || '';
  const preview = (values.firstPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const model = values.model || '';
  const models = values.models || [];
  const searchText = values.searchText || '';

  return {
    id: session.id,
    title: session.title || preview || '제목 없는 세션',
    cwd,
    folderName: cwd ? path.basename(cwd) : '알 수 없음',
    startedAt: session.timestamp || fileStat.birthtime.toISOString(),
    lastActivity: values.lastActivity || fileStat.mtime.toISOString(),
    model,
    messageCount: values.messageCount || 0,
    totalTokens: values.totalTokens || 0,
    cost: values.cost || 0,
    subagentTokens: values.subagentTokens || 0,
    subagentCost: values.subagentCost || 0,
    models,
    artifacts: values.artifacts || '',
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    filePath,
    preview,
    indexed: values.indexed === true,
    // 목록에 보이는 모델은 실제 쓴 모델이니 그 이름으로 찾을 수 있어야 한다. 서브에이전트 전용 모델도 마찬가지다.
    searchText: `${session.id}\n${session.title || ''}\n${cwd}\n${model}\n${models.map((item) => item.id).join(' ')}\n${searchText}`.toLocaleLowerCase(),
  };
}

/** Metadata-only parse: reads just the leading session line so the list can render before full indexing. */
async function parseSessionHeader(filePath, fileStat) {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    const session = JSON.parse(firstLine);
    if (session.type !== 'session' || !session.id) return null;
    return sessionResult(session, filePath, fileStat);
  } finally {
    await file.close();
  }
}

export async function parseSessionFile(filePath) {
  const fileStat = await stat(filePath);
  const header = { session: null, model: '' };
  let lastActivity = '';
  let messageCount = 0;
  let firstPrompt = '';
  let searchText = '';
  const modelUsage = new Map();
  const addUsage = (message, fallbackModel) => {
    const tokens = Number(message.usage.totalTokens) || 0;
    const spend = Number(message.usage.cost?.total) || 0;
    const modelId = messageModelId(message, fallbackModel);
    const bucket = modelUsage.get(modelId) || { id: modelId, responses: 0, tokens: 0, cost: 0 };
    bucket.responses += 1;
    bucket.tokens += tokens;
    bucket.cost += spend;
    modelUsage.set(modelId, bucket);
    return { tokens, spend };
  };

  for await (const entry of readEntries(filePath)) {
    applyHeaderEntry(header, entry);
    if (entry.timestamp && entry.timestamp > lastActivity) lastActivity = entry.timestamp;
    if (entry.type !== 'message' || !entry.message) continue;

    messageCount += 1;
    const { role, content, usage } = entry.message;
    const text = textFromContent(content);
    if (role === 'user' && !firstPrompt && text) firstPrompt = text;
    if (text && searchText.length < MAX_SEARCH_TEXT) searchText += `\n${text}`;
    if (usage) {
      addUsage(entry.message, header.model);
    }
  }

  if (!header.session?.id) return null;

  // 서브에이전트 전사본은 사용량만 걷는다. 대화 검색 인덱스는 부모 세션 본문으로 충분하고,
  // 전사본까지 넣으면 검색어가 엉뚱한 세션을 가리킨다.
  const transcripts = await collectTranscripts(artifactDirectoryFor(filePath));
  // 지문은 읽기 전에 뜬다. 읽는 도중 전사본이 자라면 이 지문은 지난 상태로 남고,
  // 다음 탐색이 불일치를 보고 다시 읽는다. 읽은 뒤에 뜨면 놓친 분량을 영영 다시 읽지 않는다.
  const artifacts = await transcriptFingerprint(transcripts);
  const subagentUsage = await mapConcurrent(transcripts, async (transcript) => {
    let transcriptModel = '';
    let tokens = 0;
    let spend = 0;
    for await (const entry of readEntries(transcript)) {
      if (entry.type === 'model_change' && entry.model) transcriptModel = entry.model;
      if (entry.type !== 'message' || !entry.message?.usage) continue;
      const added = addUsage(entry.message, transcriptModel);
      tokens += added.tokens;
      spend += added.spend;
    }
    return { tokens, spend };
  }, TRANSCRIPT_CONCURRENCY);

  const subagentTokens = subagentUsage.reduce((sum, item) => sum + item.tokens, 0);
  const subagentCost = subagentUsage.reduce((sum, item) => sum + item.spend, 0);
  // Model buckets are the accounting source of truth. Session and period totals
  // deliberately reduce these same buckets rather than a second accumulator.
  const models = [...modelUsage.values()].sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
  const totalTokens = models.reduce((sum, item) => sum + item.tokens, 0);
  const cost = models.reduce((sum, item) => sum + item.cost, 0);
  return sessionResult(header.session, filePath, fileStat, {
    model: header.model,
    lastActivity,
    messageCount,
    firstPrompt,
    totalTokens,
    cost,
    subagentTokens,
    subagentCost,
    models,
    artifacts,
    searchText: searchText.slice(0, MAX_SEARCH_TEXT),
    indexed: true,
  });
}

export async function parseSessionDetail(filePath) {
  const header = { session: null, model: '' };
  let latestUser = null;
  let lastExchange = null;

  for await (const entry of readEntries(filePath)) {
    applyHeaderEntry(header, entry);
    if (entry.type !== 'message' || !entry.message) continue;

    const text = textFromContent(entry.message.content).trim();
    if (!text) continue;
    const message = {
      text: text.slice(0, MAX_EXCHANGE_TEXT),
      timestamp: entry.timestamp || entry.message.timestamp || '',
    };

    if (entry.message.role === 'user') latestUser = message;
    if (entry.message.role === 'assistant') lastExchange = { user: latestUser, assistant: message };
  }

  if (!header.session?.id) return null;
  if (latestUser && (!lastExchange?.assistant.timestamp || latestUser.timestamp > lastExchange.assistant.timestamp)) {
    lastExchange = { user: latestUser, assistant: null };
  }

  return {
    id: header.session.id,
    title: header.session.title || '제목 없는 세션',
    cwd: header.session.cwd || '',
    model: header.model,
    lastExchange,
  };
}

/**
 * GJC 저장소 마이그레이션 잔재로 같은 세션이 구형 `-경로인코딩` 폴더와 신형 `v2-해시`
 * 폴더에 동시에 남아 있다. 둘 다 올리면 목록에 같은 세션이 두 줄 뜨고 토큰·비용도 두 번 센다.
 * 같은 id면 최근 활동이 늦은 사본만 남긴다. 시각이 같으면 더 긴 쪽을 고른다.
 */
function keepOneCopyPerSession(sessions) {
  const kept = new Map();

  for (const session of sessions) {
    const rival = kept.get(session.id);
    const wins = !rival
      || session.lastActivity > rival.lastActivity
      || (session.lastActivity === rival.lastActivity && session.size > rival.size);
    if (wins) kept.set(session.id, session);
  }

  return [...kept.values()];
}

export async function discoverSessions(directories, cachedSessions = []) {
  const files = await findSessionFiles(directories);
  const cachedByPath = new Map(cachedSessions.map((session) => [session.filePath, session]));

  const found = (await mapConcurrent(files, async (filePath) => {
    try {
      const fileStat = await stat(filePath);
      const cached = cachedByPath.get(filePath);
      if (cached?.indexed && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
        const artifacts = await transcriptFingerprint(await collectTranscripts(artifactDirectoryFor(filePath)));
        if (cached.artifacts === artifacts) return cached;
      }
      return await parseSessionHeader(filePath, fileStat);
    } catch {
      return null;
    }
  }, DISCOVERY_CONCURRENCY)).filter(Boolean);

  const copyPathsById = new Map();
  for (const session of found) {
    const paths = copyPathsById.get(session.id) || [];
    paths.push(session.filePath);
    copyPathsById.set(session.id, paths);
  }
  for (const paths of copyPathsById.values()) paths.sort();
  const sessions = keepOneCopyPerSession(found);
  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return {
    sessions,
    pendingFiles: sessions.filter((session) => !session.indexed).map((session) => session.filePath),
    copyPathsById,
  };
}

export async function indexSessionFiles(files, onSession) {
  await mapConcurrent(files, async (filePath) => {
    try {
      const session = await parseSessionFile(filePath);
      if (session) onSession(session);
    } catch {
      // One unreadable file must not abort the remaining index pass.
    }
  }, INDEX_CONCURRENCY);
}

/**
 * `from`·`to`는 UTC ISO 인스턴트다. 호출부가 로컬 하루 경계를 계산해 넘기므로
 * 여기서는 문자열 비교만 한다. lastActivity도 같은 형식이라 사전순 비교가 곧 시각 비교다.
 */
export function filterSessions(sessions, { query = '', folder = '', from = '', to = '' } = {}) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if (folder && session.cwd !== folder) return false;
    if (from && session.lastActivity < from) return false;
    if (to && session.lastActivity > to) return false;
    return terms.every((term) => session.searchText.includes(term));
  });
}

export function publicSession(session) {
  const { searchText, mtimeMs, artifacts, ...safeSession } = session;
  return safeSession;
}
