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
  const sessionDirectory = path.join(home, 'sessions');
  const agentDirectory = path.join(home, 'agent');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e37';
  const entries = [
    { type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '변경 전 제목' },
    { type: 'message', id: 'c5307ea4-1e48-4bf7-a2a7-9da1be2762ee', parentId: null, timestamp: '2026-08-10T01:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '통합 테스트' }] } },
  ];
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
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
      GJC_SESSION_DIR: sessionDirectory,
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

    const focusResponse = await fetch(`${baseUrl}/api/focus/${sessionId}`, { method: 'PUT' });
    const focused = await focusResponse.json();
    assert.equal(focusResponse.status, 200, focused.error || diagnostics);
    assert.equal(focused.session.focused, true);
    assert.equal(focused.summary.focusedCount, 1);

    const focusedListing = await (await fetch(`${baseUrl}/api/sessions?focus=1`)).json();
    assert.equal(focusedListing.resultCount, 1);
    assert.equal(focusedListing.sessions[0].id, sessionId);

    const unfocusResponse = await fetch(`${baseUrl}/api/focus/${sessionId}`, { method: 'DELETE' });
    const unfocused = await unfocusResponse.json();
    assert.equal(unfocusResponse.status, 200, unfocused.error || diagnostics);
    assert.equal(unfocused.session.focused, false);
    assert.equal(unfocused.summary.focusedCount, 0);
    assert.equal((await (await fetch(`${baseUrl}/api/sessions?focus=1`)).json()).resultCount, 0);

    assert.equal((await fetch(`${baseUrl}/api/focus/${sessionId}`, { method: 'PUT' })).status, 200);

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
    const config = JSON.parse(await readFile(path.join(home, '.gjc', 'session-list.json'), 'utf8'));
    assert.deepEqual(config.focusedSessionIds, []);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
