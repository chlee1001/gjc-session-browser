import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/sessions`);
      if (response.ok) return response.json();
    } catch {
      // Server startup can take a few polling attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('테스트 서버가 시작되지 않았습니다.');
}

test('API에서 세션 제목을 변경하고 확인 후 영구 삭제한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-session-api-'));
  const agentDirectory = path.join(home, 'agent');
  // 기본 관리 저장소 경로에 둬야 삭제가 GJC 관리 경로를 탄다.
  // 별도 폴더에 두면 FileSessionStorage 분기만 검증돼 관리 경로 회귀를 놓친다.
  const sessionDirectory = path.join(agentDirectory, 'sessions', 'v2-scope');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e37';
  const entries = [
    { type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '변경 전 제목' },
    { type: 'message', id: 'c5307ea4-1e48-4bf7-a2a7-9da1be2762ee', parentId: null, timestamp: '2026-08-10T01:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '통합 테스트' }] } },
  ];
  await mkdir(path.join(sessionDirectory, 'session'), { recursive: true });
  await writeFile(sessionFile, `${entries.map(JSON.stringify).join('\n')}\n`);

  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  server.stdout.on('data', (chunk) => { diagnostics += chunk; });
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let listing = await waitForServer(baseUrl);
    for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    assert.equal(listing.summary.indexing, false, diagnostics);
    assert.equal(listing.sessions[0].id, sessionId);

    const setStatus = async (status) => {
      const response = await fetch(`${baseUrl}/api/status/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      return { response, body: await response.json() };
    };

    const listWith = async (query) => (await (await fetch(`${baseUrl}/api/sessions?${query}`)).json());

    const active = await setStatus('active');
    assert.equal(active.response.status, 200, active.body.error || diagnostics);
    assert.equal(active.body.session.status, 'active');
    assert.equal((await listWith('status=active')).resultCount, 1);
    assert.deepEqual((await listWith('')).summary.statusCounts, { none: 0, active: 1, done: 0 });

    // 작업 중과 완료는 배타적이다. 완료로 바꾸면 작업 중에서 빠져야 한다.
    const done = await setStatus('done');
    assert.equal(done.body.session.status, 'done');
    assert.equal((await listWith('status=active')).resultCount, 0);
    assert.equal((await listWith('status=done')).resultCount, 1);

    // 여러 상태를 함께 고를 수 있어야 "완료만 빼고 보기"가 된다.
    assert.equal((await listWith('status=none,active')).resultCount, 0, '완료는 제외된다');
    assert.equal((await listWith('status=none,done')).resultCount, 1);
    assert.equal((await listWith('status=')).resultCount, 1, '고르지 않으면 전부 보인다');

    const cleared = await setStatus('none');
    assert.equal(cleared.body.session.status, 'none');
    assert.equal((await listWith('status=none,active')).resultCount, 1);

    const rejected = await setStatus('bogus');
    assert.equal(rejected.response.status, 400);

    assert.equal((await setStatus('done')).response.status, 200);

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '변경 후 제목' }),
    });
    const renamed = await renameResponse.json();
    assert.equal(renameResponse.status, 200, renamed.error || diagnostics);
    assert.equal(renamed.session.title, '변경 후 제목');
    assert.match(await readFile(sessionFile, 'utf8'), /"title":"변경 후 제목"/);

    const rejectedDelete = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'wrong-id' }),
    });
    assert.equal(rejectedDelete.status, 400);
    await access(sessionFile);

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: sessionId }),
    });
    const deleted = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200, deleted.error || diagnostics);
    assert.equal(deleted.deleted, sessionId);
    await assert.rejects(access(sessionFile));
    // 세션 파일과 동명 디렉터리는 그 세션의 아티팩트 폴더다. 함께 사라져야 한다.
    await assert.rejects(access(path.join(sessionDirectory, 'session')));
    const config = JSON.parse(await readFile(path.join(home, '.gjc', 'session-list.json'), 'utf8'));
    assert.deepEqual(config.sessionStatus, {}, '삭제된 세션의 상태는 설정에서 사라져야 한다');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
