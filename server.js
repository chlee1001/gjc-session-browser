import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
let sessionStatus = new Map();
let sessionMap = new Map();
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

async function saveConfig() {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    directories: customDirectories,
    sessionStatus: Object.fromEntries(sessionStatus),
  }, null, 2));
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
  const { sessions, pendingFiles } = await discoverSessions(configuredDirectories(), cachedSessions);
  if (currentGeneration !== generation) return;

  sessionMap = new Map(sessions.map((session) => [session.filePath, session]));
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
      sessionMap.set(session.filePath, session);
      status.indexedCount += 1;
    }).then(async () => {
      if (currentGeneration !== generation) return;
      status.indexedCount = status.totalCount;
      await saveCache(currentGeneration);
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
      sessionMap = new Map(cached.map((session) => [session.filePath, session]));
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
  for (const session of sessionMap.values()) {
    if (session.id === sessionId) return session;
  }
  return undefined;
}

function persistCache() {
  void saveCache(generation).catch((error) => console.error('Session cache save failed:', error.message));
}

function publicSessionWithState(session) {
  return { ...publicSession(session), status: sessionStatus.get(session.id) || 'none' };
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
    totalTokens += session.totalTokens;
    totalCost += session.cost;
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
    folders: [...folders.entries()]
      .map(([cwd, count]) => ({ cwd, name: path.basename(cwd), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)),
  };
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error('요청이 너무 큽니다.');
  }
  return JSON.parse(body || '{}');
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
      // GJC가 이 파일에 대한 관리 권한을 세우지 못하는 경우다. 작업 폴더가 사라졌거나
      // 관리 후보 목록에 없을 때인데, 지킬 관리 상태가 없으므로 전사본과 아티팩트만
      // 지운다. 삭제 범위는 그 세션 파일과 동명 디렉터리로 한정된다.
      // 그 외 실패(마이그레이션 잠금, 입출력)는 그대로 올린다.
      const AUTHORITY_REFUSALS = [
        'Could not resolve managed session scope',
        'Session is not an authorized managed candidate',
        'Managed session scan did not grant deletion authority',
      ];
      try {
        await SessionManager.deleteManagedCandidate(target);
      } catch (error) {
        const message = String(error?.message ?? '');
        if (!AUTHORITY_REFUSALS.some((refusal) => message.includes(refusal))) throw error;
        await new FileSessionStorage().deleteSessionWithArtifacts(target);
      }
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
        customDirectories.push(directory);
        await saveConfig();
      }
      await initializeIndex(true);
      sendJson(response, 200, { directories: configuredDirectories() });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/status/')) {
    try {
      await initializeIndex();
      const sessionId = decodeURIComponent(url.pathname.slice('/api/status/'.length));
      const session = findSessionById(sessionId);
      if (!session) {
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
      const previous = sessionStatus.get(sessionId);
      if (body.status === 'none') sessionStatus.delete(sessionId);
      else sessionStatus.set(sessionId, body.status);
      try {
        await saveConfig();
      } catch (error) {
        if (previous) sessionStatus.set(sessionId, previous);
        else sessionStatus.delete(sessionId);
        throw error;
      }
      sendJson(response, 200, { session: publicSessionWithState(session) });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/sessions/')) {
    try {
      await initializeIndex();
      const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      const session = findSessionById(sessionId);
      if (!session) {
        sendJson(response, 404, { error: '세션을 찾을 수 없습니다.' });
        return true;
      }

      if (request.method === 'PATCH') {
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
        await renameStoredSession(session, title);
        const updated = await parseSessionFile(session.filePath);
        if (!updated) throw new Error('변경된 세션을 다시 읽지 못했습니다.');
        sessionMap.set(session.filePath, updated);
        detailCache.delete(session.filePath);
        persistCache();
        sendJson(response, 200, { session: publicSessionWithState(updated) });
        return true;
      }

      if (request.method === 'DELETE') {
        if (status.indexing) {
          sendJson(response, 409, { error: '인덱싱이 끝난 뒤 다시 시도하세요.' });
          return true;
        }
        const body = await readBody(request);
        if (body.confirm !== session.id) {
          sendJson(response, 400, { error: '삭제하려면 정확한 세션 ID 확인값이 필요합니다.' });
          return true;
        }
        await deleteStoredSession(session);
        sessionMap.delete(session.filePath);
        detailCache.delete(session.filePath);
        if (sessionStatus.delete(session.id)) {
          await saveConfig().catch((error) => console.error('Session config save failed:', error.message));
        }
        status.totalCount = sessionMap.size;
        status.indexedCount = Math.min(status.indexedCount, status.totalCount);
        persistCache();
        sendJson(response, 200, { deleted: session.id });
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
      sendJson(response, 200, { ...publicSessionWithState(session), ...detail });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return true;
  }

  if (url.pathname !== '/api/sessions') return false;

  try {
    await initializeIndex(url.searchParams.get('refresh') === '1');
    const allSessions = sessionsSorted();
    const query = url.searchParams.get('q') || '';
    const folder = url.searchParams.get('folder') || '';
    const statuses = (url.searchParams.get('status') || '').split(',').filter((value) => STATUS_VALUES.includes(value));
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';

    const scoped = filterSessions(allSessions, { from, to });
    const searched = filterSessions(scoped, { query, folder });
    // 상태 칩 숫자는 자기 자신을 땜 나머지 조건 기준이다. 눌렀을 때 나오는 개수와 같아야 한다.
    const counts = { none: 0, active: 0, done: 0 };
    for (const session of searched) counts[sessionStatus.get(session.id) || 'none'] += 1;
    const filtered = statuses.length
      ? searched.filter((session) => statuses.includes(sessionStatus.get(session.id) || 'none'))
      : searched;

    const summaryOnly = url.searchParams.get('summaryOnly') === '1';
    const page = summaryOnly ? [] : filtered.slice(offset, offset + limit);
    sendJson(response, 200, {
      summary: { ...getSummary(scoped), statusCounts: counts },
      resultCount: filtered.length,
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
