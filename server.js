import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { discoverSessions, filterSessions, indexSessionFiles, parseSessionDetail, parseSessionFile, publicSession } from './session-scanner.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const agentDirectory = process.env.GJC_CODING_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
const defaultSessionDirectory = path.join(agentDirectory, 'sessions');
const configPath = path.join(homedir(), '.gjc', 'session-list.json');
const cachePath = path.join(homedir(), '.cache', 'gjc-session-list', 'index-v4.json.gz');
const port = Number(process.env.PORT) || 4175;
const isProduction = process.env.NODE_ENV === 'production';
const cliDirectories = process.argv.flatMap((argument, index, all) => argument === '--session-dir' ? [all[index + 1]] : []);
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const runFile = promisify(execFileCallback);

let customDirectories = [];
const STATUS_VALUES = ['none', 'active', 'done'];
// SDK 브로커 호출은 프로세스 spawn 한 번이 0.6초다. 요청 안에서 기다리지 않고
// 만료된 값을 그대로 돌려주면서 뒤에서 갱신한다(stale-while-revalidate).
const SDK_CALL_TIMEOUT_MS = 4000;
const SDK_LIVE_TTL_MS = 5000;
const SDK_IDLE_TTL_MS = 30000;
let sdkCache = { fetchedAt: 0, sessions: [], failures: 0 };
let sdkInflight = null;
let sessionStatus = new Map();
let sessionMap = new Map();
let sessionCopyPathsById = new Map();
let archivedSessionIds = new Set();
let pendingDeletePairs = new Map();
let modelRevision = randomUUID();
let configQueue = Promise.resolve();
let initialized = false;
let initializePromise = null;
let generation = 0;
let status = { indexing: false, indexedCount: 0, totalCount: 0, scannedAt: 0 };
let gjcPackageDirectoryPromise;
const detailCache = new Map();

function expandHome(value) {
  return path.resolve(value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

async function readCache() {
  try {
    const contents = await decompress(await readFile(cachePath));
    return JSON.parse(contents.toString('utf8')).sessions || [];
  } catch {
    return [];
  }
}

async function loadDirectories() {
  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    // A missing or malformed config falls back to an empty configuration.
  }
  customDirectories = Array.isArray(config.directories) ? config.directories.map(expandHome) : [];
  sessionStatus = new Map();
  // 이전 형식(focusedSessionIds)은 작업 중으로 옮긴다. 저장은 새 형식으로만 한다.
  for (const id of Array.isArray(config.focusedSessionIds) ? config.focusedSessionIds : []) {
    if (typeof id === 'string') sessionStatus.set(id, 'active');
  }
  for (const [id, value] of Object.entries(config.sessionStatus || {})) {
    if (value === 'active' || value === 'done') sessionStatus.set(id, value);
  }
  archivedSessionIds = new Set(
    Array.isArray(config.archivedSessionIds)
      ? config.archivedSessionIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [],
  );
}

function configuredDirectories() {
  const environmentDirectories = [
    process.env.GJC_SESSION_DIR,
    ...(process.env.GJC_SESSION_DIRS || '').split(path.delimiter),
  ];
  return [...new Set([
    defaultSessionDirectory,
    ...environmentDirectories,
    ...cliDirectories,
    ...customDirectories,
  ].filter(Boolean).map(expandHome))];
}

function configJson(draft) {
  return JSON.stringify({
    directories: draft.directories,
    sessionStatus: Object.fromEntries(draft.sessionStatus),
    archivedSessionIds: [...draft.archivedSessionIds].sort(),
  }, null, 2);
}

async function writeConfig(draft) {
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, configJson(draft));
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function rotateRevision() {
  modelRevision = randomUUID();
}

function committedDraft() {
  return {
    directories: [...customDirectories],
    sessionStatus: new Map(sessionStatus),
    archivedSessionIds: new Set(archivedSessionIds),
  };
}

function publishConfig(draft, rotate) {
  customDirectories = draft.directories;
  sessionStatus = draft.sessionStatus;
  archivedSessionIds = draft.archivedSessionIds;
  if (rotate) rotateRevision();
}

function mutateConfig(mutator) {
  const work = configQueue.then(async () => {
    const draft = committedDraft();
    const outcome = await mutator(draft);
    if (!outcome.changed) return outcome;
    await writeConfig(draft);
    publishConfig(draft, outcome.rotate !== false);
    return outcome;
  });
  configQueue = work.catch(() => {});
  return work;
}

async function saveCache(currentGeneration) {
  if (currentGeneration !== generation) return;
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.tmp`;
  const contents = JSON.stringify({ sessions: [...sessionMap.values()] });
  await writeFile(temporaryPath, await compress(contents, { level: 1 }));
  await rename(temporaryPath, cachePath);
}

async function refreshIndex(cachedSessions) {
  const currentGeneration = ++generation;
  const { sessions, pendingFiles, copyPathsById } = await discoverSessions(configuredDirectories(), cachedSessions);
  if (currentGeneration !== generation) return;

  sessionMap = new Map(sessions.map((session) => [session.id, session]));
  sessionCopyPathsById = copyPathsById;
  rotateRevision();
  status = {
    indexing: pendingFiles.length > 0,
    indexedCount: sessions.length - pendingFiles.length,
    totalCount: sessions.length,
    scannedAt: Date.now(),
  };
  initialized = true;

  if (pendingFiles.length > 0) {
    void indexSessionFiles(pendingFiles, (session) => {
      if (currentGeneration !== generation) return;
      sessionMap.set(session.id, session);
      status.indexedCount += 1;
    }).then(async () => {
      if (currentGeneration !== generation) return;
      status.indexedCount = status.totalCount;
      await saveCache(currentGeneration);
      rotateRevision();
      status.indexing = false;
    });
  } else {
    await saveCache(currentGeneration);
    status.indexing = false;
  }
}

async function initializeIndex(force = false) {
  if (initialized && !force) return;
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (!initialized) await loadDirectories();

    if (force) {
      await refreshIndex([...sessionMap.values()]);
      return;
    }

    const cached = await readCache();
    if (cached.length > 0) {
      sessionMap = new Map(cached.map((session) => [session.id, session]));
      sessionCopyPathsById = new Map(cached.map((session) => [session.id, [session.filePath]]));
      status = {
        indexing: true,
        indexedCount: cached.length,
        totalCount: cached.length,
        scannedAt: Date.now(),
      };
      initialized = true;
      void refreshIndex(cached);
      return;
    }

    await refreshIndex([]);
  })().finally(() => { initializePromise = null; });

  return initializePromise;
}

function sessionsSorted() {
  return [...sessionMap.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

function findSessionById(sessionId) {
  return sessionMap.get(sessionId);
}

function persistCache() {
  void saveCache(generation).catch((error) => console.error('Session cache save failed:', error.message));
}

/**
 * 브로커가 보고하는 살아있음. `live`만 보면 안 된다 — 죽은 프로세스가 activity를
 * 남긴 잔여 항목이 실측 12건 있었다. 두 조건을 모두 만족해야 살아있는 세션이다.
 */
function isSdkLive(entry) {
  return entry?.live === true && entry?.activity?.state === 'active';
}

/**
 * 브로커가 준 시각을 ISO로 바꾼다. 실측 표본은 epoch ms 숫자지만 ISO 문자열도 받는다 —
 * 숫자로만 강제하면 문자열 시각을 조용히 버려 최근 활동이 파일 값으로 되돌아간다.
 * 값이 이상하면 빈 문자열이다. 여기서 던지면 파일 스캔만으로도 떠야 할 목록이 통째로 500이 된다.
 */
function sdkInstant(value) {
  const at = typeof value === 'string' ? Date.parse(value) : Number(value);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * `gjc sdk session list` 한 번. 브로커 부재·타임아웃·비정상 종료·JSON 파싱 실패·ok:false는
 * 전부 빈 배열로 수렴한다. 목록은 SDK 없이도 그대로 떠야 하므로 여기서 절대 던지지 않는다.
 * 테스트는 GJC_SDK_CLI로 바이너리 경로를 주입해 실제 브로커를 타지 않게 한다.
 */
async function sdkSessionList() {
  try {
    const { stdout } = await runFile(
      process.env.GJC_SDK_CLI || 'gjc',
      ['sdk', 'session', 'list', '--timeout-ms', String(SDK_CALL_TIMEOUT_MS)],
      { timeout: SDK_CALL_TIMEOUT_MS + 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    const payload = JSON.parse(stdout);
    if (payload?.ok !== true || !Array.isArray(payload.result?.sessions)) return null;
    return payload.result.sessions.filter((entry) => entry && typeof entry === 'object');
  } catch {
    return null;
  }
}

function sdkTtl() {
  return sdkCache.sessions.some(isSdkLive) ? SDK_LIVE_TTL_MS : SDK_IDLE_TTL_MS;
}

/**
 * 현재 스냅샷을 즉시 돌려주고, 만료됐으면 갱신을 뒤에서 시작한다. 이 함수는 절대 await하지 않는다.
 * 동시 요청이 겹쳐도 in-flight 하나를 공유해 CLI를 중복 spawn하지 않는다.
 */
function sdkSnapshot() {
  const stale = Date.now() - sdkCache.fetchedAt >= sdkTtl();
  if (stale && !sdkInflight) {
    sdkInflight = sdkSessionList().then((sessions) => {
      if (sessions) {
        sdkCache = { fetchedAt: Date.now(), sessions, failures: 0 };
      } else {
        const failures = sdkCache.failures + 1;
        // 한 번 실패는 일시적일 수 있어 직전 값을 유지한다. 연속 두 번이면 브로커가
        // 정말 없는 것으로 보고 비운다 — 죽은 세션을 계속 LIVE로 보여주는 것이 더 나쁘다.
        sdkCache = {
          fetchedAt: Date.now(),
          sessions: failures >= 2 ? [] : sdkCache.sessions,
          failures,
        };
      }
    }).finally(() => {
      sdkInflight = null;
    });
  }
  // sessionId 가 성한 항목만 남긴다. Map 이므로 중복 id 는 마지막 하나로 접힌다.
  return new Map(sdkCache.sessions
    .filter((entry) => typeof entry?.sessionId === 'string' && entry.sessionId.length > 0)
    .map((entry) => [entry.sessionId, entry]));
}

/** 파일 세션 위에 브로커 상태를 얹는다. 죽은 항목의 하트비트가 파일 시각을 덮지 않게 게이팅한다. */
function withSdkOverlay(session, entry) {
  const live = isSdkLive(entry);
  const activityAt = live ? sdkInstant(entry.activity?.at) : '';
  return {
    ...session,
    live,
    pid: live ? entry.pid : 0,
    sdkOnly: false,
    lastActivity: activityAt || session.lastActivity,
  };
}

/**
 * 파일이 아직 없는 살아있는 세션. 파일 세션과 같은 필드 모양으로 채워야
 * filterSessions·집계·정렬·페이지 나누기를 고치지 않고 그대로 통과한다.
 */
function sdkOnlySession(entry) {
  const cwd = entry.locator?.repo || '';
  const folderName = cwd ? path.basename(cwd) : '알 수 없음';
  // 시각을 못 믿을 땐 현재 시각으로 떨어뜨린다. 살아있다고 보고된 세션이니 지금이 가장 가까운 근사다.
  const lastActivity = sdkInstant(entry.activity?.at) || sdkInstant(entry.lastHeartbeatAt) || new Date().toISOString();
  return {
    id: entry.sessionId,
    title: `${folderName} · 기록 준비 중`,
    cwd,
    folderName,
    startedAt: '',
    lastActivity,
    model: '',
    messageCount: 0,
    totalTokens: 0,
    cost: 0,
    subagentTokens: 0,
    subagentCost: 0,
    models: [],
    size: 0,
    mtimeMs: 0,
    filePath: '',
    preview: '',
    indexed: false,
    live: true,
    pid: entry.pid || 0,
    sdkOnly: true,
    // filterSessions와 같은 소문자 정규화를 써야 검색이 파일 세션과 동일하게 동작한다.
    searchText: `${entry.sessionId}\n${cwd}\n${folderName}`.toLocaleLowerCase(),
  };
}

/** 파일 인덱스에 전혀 없는 살아있는 세션만 가상 행으로 만든다. */
function sdkOnlyRows(sdk) {
  const rows = [];
  for (const entry of sdk.values()) {
    if (!isSdkLive(entry) || findSessionById(entry.sessionId)) continue;
    rows.push(sdkOnlySession(entry));
  }
  return rows;
}

function publicSessionWithState(session) {
  return {
    ...publicSession(session),
    status: sessionStatus.get(session.id) || 'none',
    archived: archivedSessionIds.has(session.id),
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}


function getSummary(sessions) {
  const folders = new Map();
  const models = new Map();
  let totalMessages = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const session of sessions) {
    totalMessages += session.messageCount;
    if (session.cwd) folders.set(session.cwd, (folders.get(session.cwd) || 0) + 1);
    for (const usage of session.models) {
      const bucket = models.get(usage.id) || { id: usage.id, sessions: 0, responses: 0, tokens: 0, cost: 0 };
      bucket.sessions += 1;
      bucket.responses += usage.responses;
      bucket.tokens += usage.tokens;
      bucket.cost += usage.cost;
      models.set(usage.id, bucket);
    }
  }
  for (const bucket of models.values()) {
    totalTokens += bucket.tokens;
    totalCost += bucket.cost;
  }

  return {
    sessionCount: sessions.length,
    folderCount: folders.size,
    totalMessages,
    totalTokens,
    totalCost,
    scannedAt: new Date(status.scannedAt).toISOString(),
    sessionDirectories: configuredDirectories(),
    indexing: status.indexing,
    indexedCount: status.indexedCount,
    totalCount: status.totalCount,
    archivedSessionCount: sessions.filter((session) => archivedSessionIds.has(session.id)).length,
    modelRevision,
    folders: [...folders.entries()]
      .map(([cwd, count]) => ({ cwd, name: path.basename(cwd), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)),
  };
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8_000) {
      const error = new Error('Request body too large.');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sessionRootFor(filePath) {
  return configuredDirectories()
    .sort((left, right) => right.length - left.length)
    .find((directory) => {
      const relative = path.relative(directory, filePath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

async function resolveGjcPackageDirectory() {
  if (!gjcPackageDirectoryPromise) {
    gjcPackageDirectoryPromise = (async () => {
      const candidates = [];
      if (process.env.GJC_PACKAGE_DIR) candidates.push(path.resolve(process.env.GJC_PACKAGE_DIR));
      const { stdout } = await runFile('bun', ['pm', 'ls', '-g'], { timeout: 10_000 });
      const globalRoot = stdout.split('\n', 1)[0]?.replace(/\s+node_modules.*$/, '');
      if (globalRoot) candidates.push(path.join(globalRoot, 'node_modules', '@gajae-code', 'coding-agent'));

      for (const candidate of candidates) {
        try {
          await stat(path.join(candidate, 'src', 'session', 'session-manager.ts'));
          return candidate;
        } catch {
          continue;
        }
      }
      throw new Error('GJC 패키지 위치를 찾을 수 없습니다.');
    })();
  }
  return gjcPackageDirectoryPromise;
}

function gjcModuleUrl(packageDirectory, moduleName) {
  return pathToFileURL(path.join(packageDirectory, 'src', 'session', moduleName)).href;
}

function gjcNativeModuleUrl(packageDirectory) {
  return pathToFileURL(path.join(path.dirname(packageDirectory), 'natives', 'native', 'index.js')).href;
}

/**
 * Run one Bun script against the installed GJC session modules. Inputs travel as env, never as source text.
 * 실패하면 스크립트 본문이 통째로 담긴 셸 오류 대신 GJC가 던진 문장만 남긴다.
 */
async function runGjcScript(script, env) {
  try {
    await runFile('bun', ['-e', script], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const reason = /^\s*(?:\[Uncaught Exception\]\s*)?(?:\w*Error): (.+)$/m.exec(error.stderr || '');
    throw new Error(reason ? reason[1].trim() : 'GJC 세션 작업이 실패했습니다.');
  }
}

async function managedPathsReadOnly(entries) {
  if (entries.length === 0) return new Set();
  const packageDirectory = await resolveGjcPackageDirectory();
  const script = `
    const { SessionManager } = await import(process.env.GJC_MANAGER_URL);
    const entries = JSON.parse(process.env.GJC_MANAGED_ENTRIES);
    const authorized = [];
    for (const entry of entries) {
      const sessions = await SessionManager.listManagedForResumePickerReadOnly(
        entry.cwd, process.env.GJC_AGENT_DIR,
      );
      if (sessions.some((session) => session.path === entry.sourcePath)) authorized.push(entry.sourcePath);
    }
    process.stdout.write(JSON.stringify(authorized));
  `;
  try {
    const { stdout } = await runFile('bun', ['-e', script], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GJC_MANAGED_ENTRIES: JSON.stringify(entries),
        GJC_AGENT_DIR: agentDirectory,
        GJC_MANAGER_URL: gjcModuleUrl(packageDirectory, 'session-manager.ts'),
      },
    });
    return new Set(JSON.parse(stdout));
  } catch {
    // Read-only inventory failures grant no deletion authority.
    return new Set();
  }
}

async function renameStoredSession(session, title) {
  if (!sessionRootFor(session.filePath)) throw new Error('등록된 세션 저장소 밖의 파일은 수정할 수 없습니다.');
  const packageDirectory = await resolveGjcPackageDirectory();
  const script = `
    const { SessionManager } = await import(process.env.GJC_MANAGER_URL);
    const manager = await SessionManager.open(
      process.env.GJC_RENAME_TARGET,
      undefined,
      undefined,
      "copy-retain",
      "off",
    );
    try {
      if (!await manager.setSessionName(process.env.GJC_RENAME_TITLE, "user")) {
        throw new Error("세션 제목을 변경하지 못했습니다.");
      }
    } finally {
      const outcome = await manager.flushAndCloseStrict();
      if (outcome.kind !== "closed") throw new Error("세션 저장소를 안전하게 닫지 못했습니다.");
    }
  `;
  await runGjcScript(script, {
    GJC_RENAME_TARGET: session.filePath,
    GJC_RENAME_TITLE: title,
    GJC_MANAGER_URL: gjcModuleUrl(packageDirectory, 'session-manager.ts'),
  });
}

async function deleteStoredSession(session) {
  const sessionRoot = sessionRootFor(session.filePath);
  if (!sessionRoot) throw new Error('등록된 세션 저장소 밖의 파일은 삭제할 수 없습니다.');
  const packageDirectory = await resolveGjcPackageDirectory();
  const script = `
    const target = process.env.GJC_DELETE_TARGET;
    const root = process.env.GJC_DELETE_ROOT;
    const defaultRoot = process.env.GJC_DEFAULT_SESSION_ROOT;
    const { FileSessionStorage } = await import(process.env.GJC_STORAGE_URL);
    if (root !== defaultRoot) {
      await new FileSessionStorage().deleteSessionWithArtifacts(target);
    } else {
      const { SessionManager } = await import(process.env.GJC_MANAGER_URL);
      await SessionManager.deleteManagedCandidate(target);
    }
  `;
  await runGjcScript(script, {
    GJC_DELETE_TARGET: session.filePath,
    GJC_DELETE_ROOT: sessionRoot,
    GJC_DEFAULT_SESSION_ROOT: path.resolve(defaultSessionDirectory),
    GJC_MANAGER_URL: gjcModuleUrl(packageDirectory, 'session-manager.ts'),
    GJC_STORAGE_URL: gjcModuleUrl(packageDirectory, 'session-storage.ts'),
  });
}

async function deleteAuthorizedArtifactOnly(pair) {
  if (sessionRootFor(pair.sourcePath) !== path.resolve(defaultSessionDirectory)
    || pair.artifactPath !== artifactPathFor(pair.sourcePath)
    || pair.managedAuthorized !== true) {
    throw deletionError('delete_preflight_failed', '승인되지 않은 아티팩트 삭제입니다.');
  }
  if (!pair.managedArtifactSnapshot) throw deletionError('delete_preflight_failed', '보관된 아티팩트 식별 정보가 없습니다.');
  const packageDirectory = await resolveGjcPackageDirectory();
  const script = `
    const { openRecoveryFsRoot } = await import(process.env.GJC_NATIVE_URL);
    const authority = openRecoveryFsRoot(process.env.GJC_ARTIFACT_ROOT);
    try {
      const removed = authority.removeManagedTree(process.env.GJC_ARTIFACT_RELATIVE, JSON.parse(process.env.GJC_ARTIFACT_SNAPSHOT));
      if (!removed.ok && removed.code !== "not_found") throw new Error(removed.code ?? "managed_artifact_remove_failed");
    } finally {
      const closed = authority.close();
      if (!closed.ok) throw new Error(closed.code ?? "managed_artifact_authority_close_failed");
    }
  `;
  await runGjcScript(script, {
    GJC_ARTIFACT_ROOT: path.dirname(pair.sourcePath),
    GJC_ARTIFACT_RELATIVE: path.basename(pair.artifactPath),
    GJC_ARTIFACT_SNAPSHOT: JSON.stringify(pair.managedArtifactSnapshot),
    GJC_NATIVE_URL: gjcNativeModuleUrl(packageDirectory),
  });
}

function artifactPathFor(sourcePath) {
  return sourcePath.endsWith('.jsonl') ? sourcePath.slice(0, -'.jsonl'.length) : '';
}

async function pairAuthority(pair) {
  const root = sessionRootFor(pair.sourcePath);
  if (!root || pair.artifactPath !== artifactPathFor(pair.sourcePath)) return { authorized: false, reason: 'not_authorized' };
  try {
    const source = await stat(pair.sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const artifact = await stat(pair.artifactPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (source && !source.isFile()) return { authorized: false, reason: 'invalid_source' };
    if (artifact && !artifact.isDirectory()) return { authorized: false, reason: 'invalid_artifact' };
    return { authorized: true, sourceExists: Boolean(source), artifactExists: Boolean(artifact) };
  } catch {
    return { authorized: false, reason: 'inaccessible' };
  }
}

function frozenPairsFor(sessionId) {
  const pending = pendingDeletePairs.get(sessionId);
  if (pending) return pending.map((pair) => ({ ...pair }));
  const paths = sessionCopyPathsById.get(sessionId) || [];
  return [...new Set(paths)].sort().map((sourcePath) => ({ sourcePath, artifactPath: artifactPathFor(sourcePath) }));
}

async function authorizePairsForDelete(pairs, fallbackCwd) {
  const checks = await Promise.all(pairs.map(pairAuthority));
  const managedEntries = await Promise.all(pairs.map(async (pair, index) => {
    if (!checks[index].authorized || !checks[index].sourceExists
      || sessionRootFor(pair.sourcePath) !== path.resolve(defaultSessionDirectory)) return null;
    const detail = await parseSessionDetail(pair.sourcePath).catch(() => null);
    return { sourcePath: pair.sourcePath, cwd: detail?.cwd || fallbackCwd || '' };
  }));
  const managedAuthorized = await managedPathsReadOnly(managedEntries.filter(Boolean));
  return checks.map((check, index) => {
    const defaultManaged = managedEntries[index];
    if (defaultManaged && !managedAuthorized.has(defaultManaged.sourcePath)) {
      return { ...check, authorized: false, reason: 'manager_authority_refused' };
    }
    // Artifact-only retry is permitted only when the initial all-pair preflight
    // durably recorded authority before its source vanished.
    if (!check.sourceExists && check.artifactExists && pairs[index].managedAuthorized === true) return check;
    if (!check.sourceExists && check.artifactExists
      && sessionRootFor(pairs[index].sourcePath) === path.resolve(defaultSessionDirectory)) {
      return { ...check, authorized: false, reason: 'managed_source_missing' };
    }
    return check;
  });
}

async function captureManagedArtifactSnapshots(pairs, checks) {
  const entries = pairs.flatMap((pair, index) => {
    const defaultRoot = sessionRootFor(pair.sourcePath) === path.resolve(defaultSessionDirectory);
    return defaultRoot && checks[index].authorized && checks[index].sourceExists && checks[index].artifactExists
      ? [{ index, root: path.dirname(pair.sourcePath), relative: path.basename(pair.artifactPath) }]
      : [];
  });
  if (!entries.length) return new Map();
  const packageDirectory = await resolveGjcPackageDirectory();
  const script = `
    const { openRecoveryFsRoot } = await import(process.env.GJC_NATIVE_URL);
    const entries = JSON.parse(process.env.GJC_SNAPSHOT_ENTRIES);
    const snapshots = [];
    for (const entry of entries) {
      const authority = openRecoveryFsRoot(entry.root);
      try {
        const captured = authority.snapshotManagedTree(entry.relative);
        if (captured.ok && captured.snapshot) snapshots.push({ index: entry.index, snapshot: captured.snapshot });
      } finally {
        const closed = authority.close();
        if (!closed.ok) throw new Error(closed.code ?? "managed_artifact_authority_close_failed");
      }
    }
    process.stdout.write(JSON.stringify(snapshots));
  `;
  try {
    const { stdout } = await runFile('bun', ['-e', script], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GJC_NATIVE_URL: gjcNativeModuleUrl(packageDirectory),
        GJC_SNAPSHOT_ENTRIES: JSON.stringify(entries),
      },
    });
    return new Map(JSON.parse(stdout).map(({ index, snapshot }) => [index, snapshot]));
  } catch {
    return new Map();
  }
}

function deletionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireMutableSession(sessionId) {
  if (pendingDeletePairs.has(sessionId)) throw deletionError('deletion_in_progress', '삭제가 진행 중인 세션은 변경할 수 없습니다.');
  if (!findSessionById(sessionId)) throw deletionError('not_found', '세션을 찾을 수 없습니다.');
}

async function deleteLogicalSession(session) {
  const pairs = frozenPairsFor(session.id);
  const checks = await authorizePairsForDelete(pairs, session.cwd);
  const snapshots = await captureManagedArtifactSnapshots(pairs, checks);
  for (const [index, pair] of pairs.entries()) {
    if (sessionRootFor(pair.sourcePath) === path.resolve(defaultSessionDirectory)
      && checks[index].sourceExists && checks[index].artifactExists && !snapshots.has(index)) {
      checks[index] = { ...checks[index], authorized: false, reason: 'managed_artifact_snapshot_unavailable' };
    }
    if (snapshots.has(index)) pair.managedArtifactSnapshot = snapshots.get(index);
  }
  if (!pairs.length || checks.some((check) => !check.authorized)) {
    const error = new Error('Delete preflight failed.');
    error.code = 'delete_preflight_failed';
    error.result = {
      deletedCopies: 0,
      remainingCopies: checks.filter((check) => check.sourceExists).length,
      remainingArtifacts: checks.filter((check) => check.artifactExists).length,
      remainingPairs: pairs.map((pair, index) => ({ ...pair, ...checks[index] })),
      retryable: false,
    };
    throw error;
  }
  for (const [index, pair] of pairs.entries()) pair.managedAuthorized = checks[index].authorized;
  pendingDeletePairs.set(session.id, pairs.map((pair) => ({ ...pair })));
  let failure;
  for (const pair of pairs) {
    const before = (await authorizePairsForDelete([pair], session.cwd))[0];
    if (!before.sourceExists && !before.artifactExists) continue;
    try {
      if (!before.sourceExists && before.artifactExists
        && sessionRootFor(pair.sourcePath) === path.resolve(defaultSessionDirectory)
        && pair.managedAuthorized === true) {
        await deleteAuthorizedArtifactOnly(pair);
      } else {
        await deleteStoredSession({ filePath: pair.sourcePath });
      }
    } catch (error) {
      failure = error;
    }
    const after = (await authorizePairsForDelete([pair], session.cwd))[0];
    if (!after.authorized || after.sourceExists || after.artifactExists) failure ||= new Error('Frozen deletion pair remains.');
  }
  const remaining = await authorizePairsForDelete(pairs, session.cwd);
  const remainingCopies = remaining.filter((pair) => pair.sourceExists).length;
  const remainingArtifacts = remaining.filter((pair) => pair.artifactExists).length;
  const incomplete = remaining.some((pair) => !pair.authorized || pair.sourceExists || pair.artifactExists);
  if (incomplete) {
    await refreshIndex([...sessionMap.values()]);
    const error = new Error(failure?.message || 'Partial delete.');
    error.code = 'partial_delete';
    error.result = {
      deletedCopies: pairs.length - remainingCopies,
      remainingCopies,
      remainingArtifacts,
      remainingPairs: pairs
        .map((pair, index) => ({ ...pair, ...remaining[index] }))
        .filter((pair) => !pair.authorized || pair.sourceExists || pair.artifactExists),
      retryable: true,
    };
    throw error;
  }
  // A storage operation can report an error after completing deletion. The
  // final authorized absence predicate, not that stale operation error, defines success.
  pendingDeletePairs.delete(session.id);
  sessionMap.delete(session.id);
  sessionCopyPathsById.delete(session.id);
  detailCache.delete(session.filePath);
  status.totalCount = sessionMap.size;
  status.indexedCount = Math.min(status.indexedCount, status.totalCount);
  let configPersisted = true;
  const draft = committedDraft();
  draft.sessionStatus.delete(session.id);
  draft.archivedSessionIds.delete(session.id);
  await writeConfig(draft).then(() => {
    publishConfig(draft, true);
  }).catch((error) => {
    configPersisted = false;
    publishConfig(draft, true);
    console.error('Session config save failed:', error.message);
  });
  persistCache();
  return { deleted: session.id, deletedCopies: pairs.length, configPersisted };
}

function renameSessionSerialized(sessionId, title) {
  const work = configQueue.then(async () => {
    requireMutableSession(sessionId);
    const session = findSessionById(sessionId);
    await renameStoredSession(session, title);
    const updated = await parseSessionFile(session.filePath);
    if (!updated) throw new Error('변경된 세션을 다시 읽지 못했습니다.');
    sessionMap.set(session.id, updated);
    detailCache.delete(session.filePath);
    rotateRevision();
    persistCache();
    return updated;
  });
  configQueue = work.catch(() => {});
  return work;
}

function deleteSessionSerialized(sessionId) {
  const work = configQueue.then(async () => {
    let session = findSessionById(sessionId);
    if (!session && pendingDeletePairs.has(sessionId)) {
      session = { id: sessionId, filePath: pendingDeletePairs.get(sessionId)[0].sourcePath };
    }
    if (!session) throw deletionError('not_found', '세션을 찾을 수 없습니다.');
    return deleteLogicalSession(session);
  });
  configQueue = work.catch(() => {});
  return work;
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/directories' && request.method === 'POST') {
    try {
      const body = await readBody(request);
      if (typeof body.path !== 'string' || !body.path.trim()) throw new Error('폴더 경로를 입력하세요.');
      const directory = expandHome(body.path.trim());
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) throw new Error('폴더가 아닙니다.');
      if (!configuredDirectories().includes(directory)) {
        await mutateConfig((draft) => {
          if (draft.directories.includes(directory)) return { changed: false };
          draft.directories.push(directory);
          return { changed: true, rotate: false };
        });
      }
      await initializeIndex(true);
      sendJson(response, 200, { directories: configuredDirectories() });
    } catch (error) {
      sendJson(response, error.code === 'body_too_large' ? 413 : 400, error.code === 'body_too_large' ? { code: error.code } : { error: error.message });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/status/')) {
    try {
      await initializeIndex();
      const sessionId = decodeURIComponent(url.pathname.slice('/api/status/'.length));
      const session = findSessionById(sessionId);
      // 파일이 아직 없는 살아있는 세션도 상태를 찍을 수 있다. 상태·보관은 id만으로 성립한다.
      const sdkEntry = session ? null : sdkSnapshot().get(sessionId);
      if (!session && !isSdkLive(sdkEntry)) {
        sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
        return true;
      }
      if (request.method !== 'PUT') {
        sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
        return true;
      }
      const body = await readBody(request);
      if (!STATUS_VALUES.includes(body.status)) {
        sendJson(response, 400, { error: '상태는 active, done, none 중 하나여야 합니다.' });
        return true;
      }
      await mutateConfig((draft) => {
        // requireMutableSession은 파일 세션 전용이다. 가상 세션은 삭제 진행 검사만 인라인으로 한다.
        if (session) requireMutableSession(sessionId);
        else if (pendingDeletePairs.has(sessionId)) {
          throw deletionError('deletion_in_progress', '삭제가 진행 중인 세션은 변경할 수 없습니다.');
        }
        const previous = draft.sessionStatus.get(sessionId) || 'none';
        if (previous === body.status) return { changed: false };
        if (body.status === 'none') draft.sessionStatus.delete(sessionId);
        else draft.sessionStatus.set(sessionId, body.status);
        return { changed: true };
      });
      sendJson(response, 200, {
        session: publicSessionWithState(session ? withSdkOverlay(session, sdkSnapshot().get(sessionId)) : sdkOnlySession(sdkEntry)),
      });
    } catch (error) {
      const statusCode = error.code === 'body_too_large' ? 413 : error.code === 'not_found' ? 404 : error.code === 'deletion_in_progress' ? 409 : 500;
      sendJson(response, statusCode, error.code ? { code: error.code, error: error.message } : { error: error.message });
    }
    return true;
  }

  if (url.pathname === '/api/archive') {
    if (request.method !== 'PUT') {
      sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
      return true;
    }
    try {
      await initializeIndex();
      const body = await readBody(request);
      if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || typeof body.archived !== 'boolean') {
        sendJson(response, 400, { code: 'invalid_ids' });
        return true;
      }
      const ids = [];
      const seen = new Set();
      for (const id of body.ids) {
        if (typeof id !== 'string' || !id.length) {
          sendJson(response, 400, { code: 'invalid_ids' });
          return true;
        }
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (ids.length > 200) {
        sendJson(response, 400, { code: 'too_many_ids' });
        return true;
      }
      let results;
      let changed = 0;
      // ids는 최대 200개다. 콜백 안에서 스냅샷을 다시 만들면 그만큼 Map을 재구축한다.
      const sdk = sdkSnapshot();
      await mutateConfig((draft) => {
        results = ids.map((id) => {
          if (pendingDeletePairs.has(id)) throw deletionError('deletion_in_progress', '삭제가 진행 중인 세션은 변경할 수 없습니다.');
          if (!findSessionById(id) && !isSdkLive(sdk.get(id))) return { id, outcome: 'not_found' };
          const current = draft.archivedSessionIds.has(id);
          if (current === body.archived) return { id, outcome: 'noop' };
          if (body.archived) draft.archivedSessionIds.add(id);
          else draft.archivedSessionIds.delete(id);
          changed += 1;
          return { id, outcome: 'changed' };
        });
        return { changed: changed > 0 };
      });
      sendJson(response, 200, { archived: body.archived, results, changed });
    } catch (error) {
      const statusCode = error.code === 'body_too_large' ? 413 : error.code === 'deletion_in_progress' ? 409 : 500;
      sendJson(response, statusCode, error.code ? { code: error.code, error: error.message } : { error: error.message });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/archive/')) {
    if (request.method !== 'PUT') {
      sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
      return true;
    }
    try {
      await initializeIndex();
      const sessionId = decodeURIComponent(url.pathname.slice('/api/archive/'.length));
      const session = findSessionById(sessionId);
      const sdkEntry = session ? null : sdkSnapshot().get(sessionId);
      if (!session && !isSdkLive(sdkEntry)) {
        sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
        return true;
      }
      const body = await readBody(request);
      if (!body || typeof body.archived !== 'boolean') {
        sendJson(response, 400, { code: 'invalid_archive' });
        return true;
      }
      let changed = false;
      await mutateConfig((draft) => {
        if (session) requireMutableSession(sessionId);
        else if (pendingDeletePairs.has(sessionId)) {
          throw deletionError('deletion_in_progress', '삭제가 진행 중인 세션은 변경할 수 없습니다.');
        }
        const current = draft.archivedSessionIds.has(sessionId);
        changed = current !== body.archived;
        if (!changed) return { changed: false };
        if (body.archived) draft.archivedSessionIds.add(sessionId);
        else draft.archivedSessionIds.delete(sessionId);
        return { changed: true };
      });
      sendJson(response, 200, {
        session: publicSessionWithState(session ? withSdkOverlay(session, sdkSnapshot().get(sessionId)) : sdkOnlySession(sdkEntry)),
        changed,
      });
    } catch (error) {
      const statusCode = error.code === 'body_too_large' ? 413 : error.code === 'not_found' ? 404 : error.code === 'deletion_in_progress' ? 409 : 500;
      sendJson(response, statusCode, error.code ? { code: error.code, error: error.message } : { error: error.message });
    }
    return true;
  }

  const preflightPrefix = '/api/sessions/';
  if (url.pathname.startsWith(preflightPrefix) && url.pathname.endsWith('/delete-preflight')) {
    try {
      const encodedId = url.pathname.slice(preflightPrefix.length, -'/delete-preflight'.length);
      if (!encodedId || encodedId.includes('/')) return false;
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
        return true;
      }
      let sessionId;
      try {
        sessionId = decodeURIComponent(encodedId);
      } catch {
        sendJson(response, 400, { code: 'malformed_session_id' });
        return true;
      }
      await initializeIndex();
      if (!findSessionById(sessionId) && !sessionCopyPathsById.has(sessionId) && !pendingDeletePairs.has(sessionId)) {
        sendJson(response, 404, { code: 'not_found', error: '세션을 찾을 수 없습니다.' });
        return true;
      }
      const pairs = frozenPairsFor(sessionId);
      const checks = await authorizePairsForDelete(pairs, findSessionById(sessionId)?.cwd || '');
      const reported = pairs.map((pair, index) => ({ ...pair, ...checks[index] }));
      if (!reported.length || reported.some((pair) => !pair.authorized)) {
        sendJson(response, 409, {
          code: 'delete_preflight_failed',
          pairs: reported,
          sourceCount: pairs.length,
          artifactCount: pairs.length,
          authorized: false,
        });
        return true;
      }
      sendJson(response, 200, {
        pairs: reported,
        sourceCount: pairs.length,
        artifactCount: pairs.length,
        authorized: true,
      });
    } catch (error) {
      sendJson(response, 500, { code: 'preflight_failed', error: error.message });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/sessions/')) {
    try {
      await initializeIndex();
      const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      let session = findSessionById(sessionId);
      if (!session && pendingDeletePairs.has(sessionId)) {
        session = { id: sessionId, filePath: pendingDeletePairs.get(sessionId)[0].sourcePath };
      }
      // 가상 세션은 GET 상세만 된다. 제목 변경·삭제는 아래 분기별 가드가 404로 막는다.
      if (!session && request.method === 'GET') {
        const sdkEntry = sdkSnapshot().get(sessionId);
        if (isSdkLive(sdkEntry)) {
          sendJson(response, 200, {
            ...publicSessionWithState(sdkOnlySession(sdkEntry)),
            lastExchange: null,
          });
          return true;
        }
      }
      if (!session) {
        sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
        return true;
      }

      if (request.method === 'PATCH') {
        // 공유 가드와 똑같은 술어를 분기 첫 줄에 복제한다. 좁히면 부분 삭제 재시도가 404로 막힌다.
        if (!findSessionById(sessionId) && !pendingDeletePairs.has(sessionId)) {
          sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
          return true;
        }
        if (status.indexing) {
          sendJson(response, 409, { error: '인덱싱이 끝난 뒤 다시 시도하세요.' });
          return true;
        }
        const body = await readBody(request);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title || title.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(title)) {
          sendJson(response, 400, { error: '제목은 제어문자 없이 1~120자로 입력하세요.' });
          return true;
        }
        const updated = await renameSessionSerialized(session.id, title);
        sendJson(response, 200, { session: publicSessionWithState(withSdkOverlay(updated, sdkSnapshot().get(session.id))) });
        return true;
      }

      if (request.method === 'DELETE') {
        if (!findSessionById(sessionId) && !pendingDeletePairs.has(sessionId)) {
          sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
          return true;
        }
        if (status.indexing) {
          sendJson(response, 409, { error: '인덱싱이 끝난 뒤 다시 시도하세요.' });
          return true;
        }
        const body = await readBody(request);
        if (!body || body.confirm !== session.id) {
          sendJson(response, 400, { error: '삭제하려면 정확한 세션 ID 확인값이 필요합니다.' });
          return true;
        }
        sendJson(response, 200, await deleteSessionSerialized(session.id));
        return true;
      }

      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
        return true;
      }
      const cached = detailCache.get(session.filePath);
      let detail;
      if (cached?.mtimeMs === session.mtimeMs) {
        detail = cached.detail;
      } else {
        detail = await parseSessionDetail(session.filePath);
        detailCache.set(session.filePath, { mtimeMs: session.mtimeMs, detail });
      }
      // 목록과 같은 오버레이를 얹는다. 없으면 LIVE인 세션을 열었을 때 프로세스·실시간 칸이 사라진다.
      const overlaid = withSdkOverlay(session, sdkSnapshot().get(session.id));
      sendJson(response, 200, { ...publicSessionWithState(overlaid), ...detail });
    } catch (error) {
      const statusCode = error.code === 'body_too_large' ? 413 : error.code === 'not_found' ? 404 : error.code === 'deletion_in_progress' ? 409 : 500;
      sendJson(response, statusCode,
        error.code ? { code: error.code, ...(error.result || {}), error: error.message } : { error: error.message });
    }
    return true;
  }

  if (url.pathname === '/api/models/sessions') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '지원하지 않는 요청 방식입니다.' });
      return true;
    }
    await initializeIndex();
    if (status.indexing) {
      sendJson(response, 409, { code: 'indexing' });
      return true;
    }
    if (!url.searchParams.has('model')) {
      sendJson(response, 400, { code: 'missing_model' });
      return true;
    }
    const strictInteger = (name, fallback, minimum, maximum) => {
      if (!url.searchParams.has(name)) return fallback;
      const value = url.searchParams.get(name);
      if (!/^(0|[1-9]\d*)$/.test(value)) return null;
      const parsed = Number(value);
      return parsed >= minimum && parsed <= maximum ? parsed : null;
    };
    const offset = strictInteger('offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = strictInteger('limit', 50, 1, 100);
    if (offset === null || limit === null) {
      sendJson(response, 400, { code: 'invalid_pagination' });
      return true;
    }
    const revision = url.searchParams.get('revision');
    if (offset > 0 && !revision) {
      sendJson(response, 400, { code: 'missing_revision' });
      return true;
    }
    if (revision && revision !== modelRevision) {
      sendJson(response, 409, { code: 'stale_revision', currentRevision: modelRevision });
      return true;
    }
    const model = url.searchParams.get('model');
    const sessions = filterSessions(sessionsSorted(), {
      from: url.searchParams.get('from') || '',
      to: url.searchParams.get('to') || '',
    });
    const contributions = sessions
      .map((session) => ({ session, usage: session.models.find((usage) => usage.id === model) }))
      .filter(({ usage }) => usage)
      .sort((left, right) => right.usage.tokens - left.usage.tokens
        || right.session.lastActivity.localeCompare(left.session.lastActivity)
        || left.session.id.localeCompare(right.session.id))
      .map(({ session, usage }) => ({
        id: session.id,
        title: session.title,
        preview: session.preview.replace(/\s+/g, ' ').trim().slice(0, 160),
        cwd: session.cwd,
        folderName: session.folderName,
        lastActivity: session.lastActivity,
        status: sessionStatus.get(session.id) || 'none',
        archived: archivedSessionIds.has(session.id),
        usage: { responses: usage.responses, tokens: usage.tokens, cost: usage.cost },
      }));
    const page = contributions.slice(offset, offset + limit);
    sendJson(response, 200, {
      model,
      revision: modelRevision,
      offset,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < contributions.length,
      contributions: page,
    });
    return true;
  }

  if (url.pathname !== '/api/sessions') return false;

  try {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    await initializeIndex(forceRefresh);
    // "다시 스캔"은 SDK 상태까지 지금 것으로 보자는 뜻이다.
    if (forceRefresh) sdkCache = { ...sdkCache, fetchedAt: 0 };
    const sdk = sdkSnapshot();
    const fileSessions = sessionsSorted().map((session) => withSdkOverlay(session, sdk.get(session.id)));
    // 합집합은 여기 한 번만 만들고, 이후 필터·집계·정렬·페이지 나누기는 손대지 않는다.
    const allSessions = [...fileSessions, ...sdkOnlyRows(sdk)];
    const query = url.searchParams.get('q') || '';
    const folder = url.searchParams.get('folder') || '';
    const statuses = (url.searchParams.get('status') || '').split(',').filter((value) => STATUS_VALUES.includes(value));
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const archive = ['current', 'archived', 'all'].includes(url.searchParams.get('archive')) ? url.searchParams.get('archive') : 'current';
    const sort = url.searchParams.has('sort') ? url.searchParams.get('sort') : 'recent';
    if (!['recent', 'tokens', 'cost'].includes(sort)) {
      sendJson(response, 400, { code: 'invalid_sort' });
      return true;
    }
    const liveOnly = url.searchParams.get('live') === '1';

    const scoped = filterSessions(allSessions, { from, to });
    const searched = filterSessions(scoped, { query, folder });
    const statusSearched = statuses.length
      ? searched.filter((session) => statuses.includes(sessionStatus.get(session.id) || 'none'))
      : searched;
    const archiveCounts = { current: 0, archived: 0, all: statusSearched.length };
    for (const session of statusSearched) archiveCounts[archivedSessionIds.has(session.id) ? 'archived' : 'current'] += 1;
    const archiveVisible = archive === 'all'
      ? searched
      : searched.filter((session) => archivedSessionIds.has(session.id) === (archive === 'archived'));
    // 상태 칩 숫자는 자기 자신을 땜 나머지 조건 기준이다. 눌렀을 때 나오는 개수와 같아야 한다.
    const counts = { none: 0, active: 0, done: 0 };
    for (const session of archiveVisible) counts[sessionStatus.get(session.id) || 'none'] += 1;
    const scopedByFilters = archiveVisible.filter((session) => statuses.length === 0
      || statuses.includes(sessionStatus.get(session.id) || 'none'));
    // 실행 중 칩 숫자는 live 축을 걸기 전 기준이다. 그래야 칩을 눌렀을 때 나오는 개수와 같다.
    const liveCount = scopedByFilters.filter((session) => session.live).length;
    const filtered = liveOnly ? scopedByFilters.filter((session) => session.live) : scopedByFilters;
    filtered.sort((left, right) => {
      if (sort === 'tokens' && right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens;
      if (sort === 'cost' && right.cost !== left.cost) return right.cost - left.cost;
      if (sort !== 'recent' && right.lastActivity !== left.lastActivity) return right.lastActivity.localeCompare(left.lastActivity);
      return sort === 'recent'
        ? right.lastActivity.localeCompare(left.lastActivity) || left.id.localeCompare(right.id)
        : left.id.localeCompare(right.id);
    });

    const summaryOnly = url.searchParams.get('summaryOnly') === '1';
    const page = summaryOnly ? [] : filtered.slice(offset, offset + limit);
    // 토큰·비용·메시지 총계는 파일 진실만 센다. 가상 세션은 그 숫자를 모른다.
    const summary = getSummary(scoped.filter((session) => !session.sdkOnly));
    // 폴더 옵션에는 SDK-only 세션의 repo도 들어가야 그 폴더로 걸러볼 수 있다.
    // 덧붙이기가 아니라 개수 누적이어야 파일과 SDK가 섞인 폴더의 숫자가 맞는다.
    const folderIndex = new Map(summary.folders.map((item) => [item.cwd, { ...item }]));
    for (const session of scoped) {
      if (!session.sdkOnly || !session.cwd) continue;
      const hit = folderIndex.get(session.cwd);
      if (hit) hit.count += 1;
      else folderIndex.set(session.cwd, { cwd: session.cwd, name: path.basename(session.cwd), count: 1 });
    }
    summary.folders = [...folderIndex.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    summary.folderCount = summary.folders.length;
    // 목록 재조정은 파일 세션 기준으로만 비교한다. 가상 행은 브로커 사정으로 늘고 줄어서
    // 사용자 조작에 대한 기대 개수와 무관하다.
    const fileResultCount = filtered.filter((session) => !session.sdkOnly).length;
    sendJson(response, 200, {
      summary: { ...summary, statusCounts: counts, archiveCounts, liveCount },
      resultCount: filtered.length,
      fileResultCount,
      sdkOnlyCount: filtered.length - fileResultCount,
      offset,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < filtered.length,
      sessions: page.map(publicSessionWithState),
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
  return true;
}

let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
}

const server = createServer(async (request, response) => {
  if (await handleApi(request, response)) return;

  if (vite) {
    vite.middlewares(request, response, () => {
      response.writeHead(404);
      response.end('Not found');
    });
    return;
  }

  try {
    const requestedPath = request.url === '/' ? 'index.html' : request.url.slice(1);
    const safePath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(root, 'dist', safePath);
    const content = await readFile(filePath);
    const extension = path.extname(filePath);
    const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': `${contentTypes[extension] || 'application/octet-stream'}; charset=utf-8` });
    response.end(content);
  } catch {
    try {
      const html = await readFile(path.join(root, 'dist', 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch {
      response.writeHead(404);
      response.end('Run npm run build first.');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`GJC Sessions: http://127.0.0.1:${port}`);
  console.log(`Scanning: ${configuredDirectories().join(', ')}`);
});
