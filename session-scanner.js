import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const MAX_SEARCH_TEXT = 32_000;
const MAX_EXCHANGE_TEXT = 4_000;
const HEADER_READ_BYTES = 16_384;
const DISCOVERY_CONCURRENCY = 32;
const INDEX_CONCURRENCY = 12;

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
 * 아티팩트와 서브에이전트 트랜스크립트를 담는다. 그 안의 .jsonl은 독립 세션이
 * 아니므로 트리째 건너뛴다. 넣으면 목록이 서브에이전트 기록으로 뒤덮이고,
 * 삭제도 실패한다 — GJC의 관리 세션 삭제는 `<저장소>/<폴더>/<파일>` 배치를 전제한다.
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
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    filePath,
    preview,
    indexed: values.indexed === true,
    searchText: `${session.id}\n${session.title || ''}\n${cwd}\n${model}\n${searchText}`.toLocaleLowerCase(),
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
  let totalTokens = 0;
  let cost = 0;
  let searchText = '';

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
      totalTokens += Number(usage.totalTokens) || 0;
      cost += Number(usage.cost?.total) || 0;
    }
  }

  if (!header.session?.id) return null;
  return sessionResult(header.session, filePath, fileStat, {
    model: header.model,
    lastActivity,
    messageCount,
    firstPrompt,
    totalTokens,
    cost,
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

export async function discoverSessions(directories, cachedSessions = []) {
  const files = await findSessionFiles(directories);
  const cachedByPath = new Map(cachedSessions.map((session) => [session.filePath, session]));
  const pendingFiles = [];

  const sessions = (await mapConcurrent(files, async (filePath) => {
    try {
      const fileStat = await stat(filePath);
      const cached = cachedByPath.get(filePath);
      if (cached?.indexed && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) return cached;
      const session = await parseSessionHeader(filePath, fileStat);
      if (session) pendingFiles.push(filePath);
      return session;
    } catch {
      return null;
    }
  }, DISCOVERY_CONCURRENCY)).filter(Boolean);

  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return { sessions, pendingFiles };
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
  const { searchText, mtimeMs, ...safeSession } = session;
  return safeSession;
}
