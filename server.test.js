import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // Registered custom roots use the narrowly scoped storage deletion path.
  const registeredRoot = path.join(home, 'registered-sessions');
  const sessionDirectory = path.join(registeredRoot, 'v2-scope');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const copiedSessionDirectory = path.join(registeredRoot, 'legacy-scope');
  const copiedSessionFile = path.join(copiedSessionDirectory, 'session.jsonl');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e37';
  const entries = [
    { type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '변경 전 제목' },
    { type: 'message', id: 'c5307ea4-1e48-4bf7-a2a7-9da1be2762ee', parentId: null, timestamp: '2026-08-10T01:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '통합 테스트' }] } },
    { type: 'message', id: 'a1b2c3d4-0000-4000-8000-000000000001', parentId: 'c5307ea4-1e48-4bf7-a2a7-9da1be2762ee', timestamp: '2026-08-10T01:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '확인했습니다.' }], provider: 'anthropic', model: 'claude-test', usage: { totalTokens: 120, cost: { total: 0.5 } } } },
    { type: 'message', id: 'a1b2c3d4-0000-4000-8000-000000000002', parentId: 'a1b2c3d4-0000-4000-8000-000000000001', timestamp: '2026-08-10T01:03:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '마저 했습니다.' }], provider: 'openai', model: 'gpt-test', usage: { totalTokens: 80, cost: { total: 0.25 } } } },
  ];
  await mkdir(path.join(sessionDirectory, 'session'), { recursive: true });
  await mkdir(path.join(copiedSessionDirectory, 'session'), { recursive: true });
  await writeFile(sessionFile, `${entries.map(JSON.stringify).join('\n')}\n`);
  await writeFile(copiedSessionFile, `${entries.map(JSON.stringify).join('\n')}\n`);

  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SESSION_DIR: registeredRoot,
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
    assert.equal((await fetch(`${baseUrl}/api/sessions/%E0%A4%A/delete-preflight`)).status, 400);
    assert.equal(listing.summary.totalTokens, 200);
    assert.deepEqual(listing.summary.models, [
      { id: 'anthropic/claude-test', sessions: 1, responses: 1, tokens: 120, cost: 0.5 },
      { id: 'openai/gpt-test', sessions: 1, responses: 1, tokens: 80, cost: 0.25 },
    ], '기간 통계의 토큰은 모델별로도 나뉘어 나온다');

    const archiveResponse = await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    const archived = await archiveResponse.json();
    assert.equal(archiveResponse.status, 200, archived.error || diagnostics);
    assert.equal(archived.changed, true);
    assert.equal((await (await fetch(`${baseUrl}/api/sessions`)).json()).resultCount, 0, '기본 목록은 보관본을 숨긴다');
    const archivedList = await (await fetch(`${baseUrl}/api/sessions?archive=archived&sort=tokens`)).json();
    assert.equal(archivedList.sessions[0].archived, true);
    assert.equal(archivedList.summary.totalTokens, 200, '보관본도 기간 합계에는 남는다');
    assert.equal(archivedList.summary.archivedSessionCount, 1);
    assert.equal((await (await fetch(`${baseUrl}/api/sessions?sort=bogus`)).json()).code, 'invalid_sort');

    const revisionBeforeNoop = archivedList.summary.modelRevision;
    const noopBatch = await fetch(`${baseUrl}/api/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [sessionId], archived: true }),
    });
    assert.equal(noopBatch.status, 200);
    assert.equal((await noopBatch.json()).changed, 0);
    assert.equal((await (await fetch(`${baseUrl}/api/sessions?archive=archived`)).json()).summary.modelRevision, revisionBeforeNoop,
      '전부 noop인 일괄 보관은 모델 revision을 바꾸지 않는다');

    const contribution = await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test`)).json();
    assert.equal(contribution.contributions.length, 1);
    assert.equal(contribution.hasMore, false);
    assert.equal(contribution.nextOffset, 1);
    assert.deepEqual(Object.keys(contribution.contributions[0]).sort(), [
      'archived', 'cwd', 'folderName', 'id', 'lastActivity', 'preview', 'status', 'title', 'usage',
    ]);
    assert.equal('searchText' in contribution.contributions[0], false);
    const unknownModel = await (await fetch(`${baseUrl}/api/models/sessions?model=unknown&limit=1`)).json();
    assert.deepEqual(unknownModel.contributions, []);
    assert.equal(unknownModel.hasMore, false);
    const overrun = await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test&offset=1&limit=1&revision=${contribution.revision}`)).json();
    assert.deepEqual(overrun.contributions, []);
    assert.equal(overrun.hasMore, false);
    assert.equal((await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test&offset=1`)).json()).code, 'missing_revision');
    assert.equal((await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test&revision=stale`)).json()).code, 'stale_revision');
    for (const query of [
      'model=anthropic%2Fclaude-test&offset=01',
      'model=anthropic%2Fclaude-test&offset=-1',
      'model=anthropic%2Fclaude-test&limit=101',
      'model=anthropic%2Fclaude-test&limit=01',
    ]) {
      assert.equal((await (await fetch(`${baseUrl}/api/models/sessions?${query}`)).json()).code, 'invalid_pagination');
    }

    const restored = await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    assert.equal(restored.status, 200);
    const revisionBeforeBatch = (await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json()).summary.modelRevision;

    const batch = await fetch(`${baseUrl}/api/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [sessionId, sessionId, 'unknown'], archived: true }),
    });
    assert.deepEqual(await batch.json(), {
      archived: true,
      results: [{ id: sessionId, outcome: 'changed' }, { id: 'unknown', outcome: 'not_found' }],
      changed: 1,
    });
    const revisionAfterBatch = (await (await fetch(`${baseUrl}/api/sessions?archive=archived`)).json()).summary.modelRevision;
    assert.notEqual(revisionAfterBatch, revisionBeforeBatch,
      '한 개 이상 바뀐 일괄 보관은 단일 공개 revision을 교체한다');
    const tooLarge = await fetch(`${baseUrl}/api/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(8_001),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { code: 'body_too_large', error: 'Request body too large.' });
    await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });

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

    await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    const oppositeFacet = await listWith('archive=archived&status=none');
    assert.equal(oppositeFacet.resultCount, 0);
    assert.deepEqual(oppositeFacet.summary.statusCounts, { none: 0, active: 1, done: 0 },
      '상태 수는 선택 상태를 빼고 보관 필터를 적용한다');
    assert.deepEqual(oppositeFacet.summary.archiveCounts, { current: 0, archived: 0, all: 0 },
      '보관 수는 보관 선택만 빼고 선택 상태를 적용한다');
    await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });

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

    const [concurrentStatus, concurrentArchive] = await Promise.all([
      setStatus('active'),
      fetch(`${baseUrl}/api/archive/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    ]);
    assert.equal(concurrentStatus.response.status, 200);
    assert.equal(concurrentArchive.status, 200);
    const concurrentConfig = JSON.parse(await readFile(path.join(home, '.gjc', 'session-list.json'), 'utf8'));
    assert.equal(concurrentConfig.sessionStatus[sessionId], 'active');
    assert.deepEqual(concurrentConfig.archivedSessionIds, [sessionId],
      '동시 설정 변경도 하나의 직렬 큐에서 서로를 잃지 않는다');
    await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    await setStatus('none');

    const configDirectory = path.join(home, '.gjc');
    const revisionBeforeFailure = (await listWith('')).summary.modelRevision;
    await chmod(configDirectory, 0o500);
    const failedWriter = await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    await chmod(configDirectory, 0o700);
    assert.equal(failedWriter.status, 500);
    const afterFailedWriter = await listWith('');
    assert.equal(afterFailedWriter.resultCount, 1);
    assert.equal(afterFailedWriter.summary.modelRevision, revisionBeforeFailure,
      '실패한 설정 쓰기는 staged revision을 공개하지 않는다');
    const recoveredWriter = await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(recoveredWriter.status, 200, '실패한 쓰기 뒤에도 큐가 회복한다');
    await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });

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
    assert.match(await readFile(renamed.session.filePath, 'utf8'), /"title":"변경 후 제목"/);

    const rejectedDelete = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'wrong-id' }),
    });
    assert.equal(rejectedDelete.status, 400);
    await access(sessionFile);

    const preflight = await fetch(`${baseUrl}/api/sessions/${sessionId}/delete-preflight`);
    const scope = await preflight.json();
    assert.equal(preflight.status, 200, scope.error || diagnostics);
    assert.equal(scope.authorized, true);
    assert.deepEqual(scope.pairs, [
      {
        sourcePath: copiedSessionFile,
        artifactPath: path.join(copiedSessionDirectory, 'session'),
        authorized: true,
        sourceExists: true,
        artifactExists: true,
      },
      {
        sourcePath: sessionFile,
        artifactPath: path.join(sessionDirectory, 'session'),
        authorized: true,
        sourceExists: true,
        artifactExists: true,
      },
    ], 'preflight는 일반 상세 경로보다 먼저 모든 중복 사본의 정확한 삭제 범위를 반환한다');

    const concurrentRename = fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '삭제 경합 제목' }),
    });
    const concurrentDelete = fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: sessionId }),
    });
    const [renameDuringDelete, deleteResponse] = await Promise.all([concurrentRename, concurrentDelete]);
    assert.ok([200, 404, 409].includes(renameDuringDelete.status),
      'PATCH와 DELETE는 직렬화되며 삭제 뒤 PATCH는 재공개할 수 없다');
    const deleted = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200, deleted.error || diagnostics);
    assert.equal(deleted.deleted, sessionId);
    await assert.rejects(access(sessionFile));
    await assert.rejects(access(copiedSessionFile));
    // 세션 파일과 동명 디렉터리는 그 세션의 아티팩트 폴더다. 함께 사라져야 한다.
    await assert.rejects(access(path.join(sessionDirectory, 'session')));
    await assert.rejects(access(path.join(copiedSessionDirectory, 'session')));
    const deletedPreflight = await fetch(`${baseUrl}/api/sessions/${sessionId}/delete-preflight`);
    assert.equal(deletedPreflight.status, 404, 'terminal delete removes the frozen copy map');
    assert.equal((await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json()).resultCount, 0,
      '경합 PATCH가 삭제된 세션을 목록에 다시 올리지 않는다');
    const config = JSON.parse(await readFile(path.join(home, '.gjc', 'session-list.json'), 'utf8'));
    assert.deepEqual(config.sessionStatus, {}, '삭제된 세션의 상태는 설정에서 사라져야 한다');
    assert.deepEqual(config.archivedSessionIds, [], '삭제된 세션의 보관 오버레이도 설정에서 사라져야 한다');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('기본 관리 경로는 승인된 아티팩트 전용 재시도로만 부분 삭제를 완료한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-default-delete-'));
  const agentDirectory = path.join(home, 'agent');
  const sessionDirectory = path.join(agentDirectory, 'sessions', 'v2-scope');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const artifactDirectory = path.join(sessionDirectory, 'session');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e38';
  const deniedDirectory = path.join(agentDirectory, 'sessions', 'v2-denied');
  const deniedSessionFile = path.join(deniedDirectory, 'session.jsonl');
  const deniedSessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e39';
  const replacedDirectory = path.join(agentDirectory, 'sessions', 'v2-replaced');
  const replacedSessionFile = path.join(replacedDirectory, 'session.jsonl');
  const replacedArtifactDirectory = path.join(replacedDirectory, 'session');
  const replacedSessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e40';
  const fakePackage = path.join(home, 'fake-gjc');
  const fakeNatives = path.join(home, 'natives', 'native');
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(path.join(deniedDirectory, 'session'), { recursive: true });
  await mkdir(replacedArtifactDirectory, { recursive: true });
  await mkdir(path.join(fakePackage, 'src', 'session'), { recursive: true });
  await mkdir(fakeNatives, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '관리 세션',
  })}\n`);
  await writeFile(deniedSessionFile, `${JSON.stringify({
    type: 'session', version: 4, id: deniedSessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '거부 세션',
  })}\n`);
  await writeFile(replacedSessionFile, `${JSON.stringify({
    type: 'session', version: 4, id: replacedSessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '교체 검증 세션',
  })}\n`);
  await writeFile(path.join(fakePackage, 'src', 'session', 'session-manager.ts'), `
    import { rm } from 'node:fs/promises';
    export class SessionManager {
      static async listManagedForResumePickerReadOnly() {
        return JSON.parse(process.env.GJC_FAKE_AUTHORIZED_PATHS).map(path => ({ path }));
      }
      static async deleteManagedCandidate(target) {
        await rm(target, { force: true });
        throw new Error('source removed before artifact cleanup');
      }
    }
  `);
  await writeFile(path.join(fakePackage, 'src', 'session', 'session-storage.ts'), `
    import { rm } from 'node:fs/promises';
    export class FileSessionStorage {
      async deleteSessionWithArtifacts(target) {
        await rm(target, { force: true });
        await rm(target.slice(0, -'.jsonl'.length), { recursive: true, force: true });
      }
    }
  `);
  await writeFile(path.join(fakeNatives, 'index.js'), `
    import { lstatSync, rmSync } from 'node:fs';
    import path from 'node:path';
    export function openRecoveryFsRoot(root) {
      return {
        snapshotManagedTree(relative) {
          try {
            const value = lstatSync(path.join(root, relative));
            return { ok: true, snapshot: { relative, ino: String(value.ino), size: String(value.size) } };
          } catch { return { ok: false, code: 'not_found' }; }
        },
        removeManagedTree(relative, expected) {
          try {
            const value = lstatSync(path.join(root, relative));
            if (expected.relative !== relative || expected.ino !== String(value.ino)) return { ok: false, code: 'identity_mismatch' };
            rmSync(path.join(root, relative), { recursive: true, force: true });
            if (process.env.GJC_FAKE_NATIVE_THROW_AFTER_REMOVE === relative) {
              return { ok: false, code: 'injected_after_remove' };
            }
            return { ok: true };
          } catch { return { ok: false, code: 'not_found' }; }
        },
        close() { return { ok: true }; },
      };
    }
  `);
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_PACKAGE_DIR: fakePackage,
      GJC_FAKE_AUTHORIZED_PATHS: JSON.stringify([sessionFile, replacedSessionFile]),
      GJC_FAKE_NATIVE_THROW_AFTER_REMOVE: 'session',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let listing = await waitForServer(baseUrl);
    for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    assert.equal(listing.summary.indexing, false);
    const denied = await fetch(`${baseUrl}/api/sessions/${deniedSessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: deniedSessionId }),
    });
    assert.equal(denied.status, 500);
    assert.equal((await denied.json()).code, 'delete_preflight_failed');
    await access(deniedSessionFile);
    const request = () => fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: sessionId }),
    });
    const first = await request();
    const partial = await first.json();
    assert.equal(first.status, 500);
    assert.equal(partial.code, 'partial_delete');
    assert.equal(partial.remainingCopies, 0);
    assert.equal(partial.remainingArtifacts, 1);
    assert.deepEqual(partial.remainingPairs.map(({ sourcePath, artifactPath, sourceExists, artifactExists }) => ({
      sourcePath, artifactPath, sourceExists, artifactExists,
    })), [{ sourcePath: sessionFile, artifactPath: artifactDirectory, sourceExists: false, artifactExists: true }]);
    await assert.rejects(access(sessionFile));
    await access(artifactDirectory);
    const second = await request();
    assert.equal(second.status, 200, await second.text());
    await assert.rejects(access(artifactDirectory));

    const replacementRequest = () => fetch(`${baseUrl}/api/sessions/${replacedSessionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: replacedSessionId }),
    });
    const replacementFirst = await replacementRequest();
    assert.equal(replacementFirst.status, 500);
    assert.equal((await replacementFirst.json()).code, 'partial_delete');
    await assert.rejects(access(replacedSessionFile));
    await rm(replacedArtifactDirectory, { recursive: true, force: true });
    await mkdir(replacedArtifactDirectory);
    await writeFile(path.join(replacedArtifactDirectory, 'replacement.txt'), 'must survive stale cleanup');
    const replacementRetry = await replacementRequest();
    const replacementRetryBody = await replacementRetry.json();
    assert.equal(replacementRetry.status, 500);
    assert.equal(replacementRetryBody.code, 'partial_delete');
    assert.equal(replacementRetryBody.remainingArtifacts, 1);
    await access(path.join(replacedArtifactDirectory, 'replacement.txt'));
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('원자적 설정 공개 전에는 목록과 revision이 함께 이전 상태를 유지한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-delayed-config-'));
  const agentDirectory = path.join(home, 'agent');
  const sessionRoot = path.join(home, 'sessions');
  const sessionDirectory = path.join(sessionRoot, 'scope');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e41';
  const hookPath = path.join(home, 'delay-config-rename.mjs');
  const readyPath = path.join(home, 'config-write-ready');
  const releasePath = path.join(home, 'config-write-release');
  await mkdir(path.join(sessionDirectory, 'session'), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '지연 공개',
  })}\n`);
  await writeFile(hookPath, `
    import fs from 'node:fs';
    import { access, writeFile } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (source, destination) => {
      if (destination === process.env.GJC_TEST_CONFIG_PATH && source.endsWith('.tmp')) {
        await writeFile(process.env.GJC_TEST_READY_PATH, 'ready');
        while (true) {
          try { await access(process.env.GJC_TEST_RELEASE_PATH); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
  `);
  const port = await availablePort();
  const server = spawn(process.execPath, ['--import', hookPath, 'server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SESSION_DIR: sessionRoot,
      GJC_TEST_CONFIG_PATH: path.join(home, '.gjc', 'session-list.json'),
      GJC_TEST_READY_PATH: readyPath,
      GJC_TEST_RELEASE_PATH: releasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let listing = await waitForServer(baseUrl);
    for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    const oldRevision = listing.summary.modelRevision;
    const archive = fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await access(readyPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await access(readyPath);
    const whileBlocked = await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json();
    assert.equal(whileBlocked.sessions[0].archived, false);
    assert.equal(whileBlocked.summary.modelRevision, oldRevision);
    await writeFile(releasePath, 'release');
    assert.equal((await archive).status, 200);
    const afterRelease = await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json();
    assert.equal(afterRelease.sessions[0].archived, true);
    assert.notEqual(afterRelease.summary.modelRevision, oldRevision);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('삭제 뒤 설정 저장 실패도 원본 삭제를 되살리지 않고 다음 저장과 재시작에서 회복한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-delete-config-recovery-'));
  const agentDirectory = path.join(home, 'agent');
  const sessionRoot = path.join(home, 'sessions');
  const sessionDirectory = path.join(sessionRoot, 'scope');
  const sessionFile = path.join(sessionDirectory, 'session.jsonl');
  const sessionId = '9d51d5d8-861c-4c03-9938-c78f75c62e42';
  await mkdir(path.join(sessionDirectory, 'session'), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '삭제 복구',
  })}\n`);
  const start = async (port) => spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, HOME: home, NODE_ENV: 'production', PORT: String(port), GJC_CODING_AGENT_DIR: agentDirectory, GJC_SESSION_DIR: sessionRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port = await availablePort();
  let server = await start(port);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let listing = await waitForServer(baseUrl);
    for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    await fetch(`${baseUrl}/api/status/${sessionId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) });
    await fetch(`${baseUrl}/api/archive/${sessionId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    const oldRevision = (await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json()).summary.modelRevision;
    await chmod(path.join(home, '.gjc'), 0o500);
    const deleted = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: sessionId }),
    });
    await chmod(path.join(home, '.gjc'), 0o700);
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200);
    assert.equal(deletedBody.configPersisted, false);
    await assert.rejects(access(sessionFile));
    const sourceTruth = await (await fetch(`${baseUrl}/api/sessions?archive=all`)).json();
    assert.equal(sourceTruth.resultCount, 0);
    assert.notEqual(sourceTruth.summary.modelRevision, oldRevision);
    const extraDirectory = path.join(home, 'persist-after-delete');
    await mkdir(extraDirectory);
    const recovered = await fetch(`${baseUrl}/api/directories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: extraDirectory }),
    });
    assert.equal(recovered.status, 200);
    const persisted = JSON.parse(await readFile(path.join(home, '.gjc', 'session-list.json'), 'utf8'));
    assert.deepEqual(persisted.sessionStatus, {});
    assert.deepEqual(persisted.archivedSessionIds, []);
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    port = await availablePort();
    server = await start(port);
    const restarted = await waitForServer(`http://127.0.0.1:${port}`);
    assert.equal(restarted.resultCount, 0);
    assert.equal(restarted.summary.archivedSessionCount, 0);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
