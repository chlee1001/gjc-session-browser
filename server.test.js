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

/**
 * 테스트는 실제 브로커를 타면 안 된다. 개발 머신에서 gjc가 PATH에 있으면 살아있는 세션이
 * 섞여 들어와 단언이 흔들린다. GJC_SDK_CLI로 이 스텁을 주입해 응답을 고정한다.
 */
async function writeSdkStub(home, payload, { closePayload = { ok: true }, closeStdout, closeExitCode = 0 } = {}) {
  const stub = path.join(home, "sdk-stub.mjs");
  await writeFile(stub, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const closedPath = ${JSON.stringify(path.join(home, 'sdk-closed.json'))};
const closed = existsSync(closedPath) ? JSON.parse(readFileSync(closedPath, 'utf8')) : [];
appendFileSync(${JSON.stringify(path.join(home, 'sdk-invocations.jsonl'))}, JSON.stringify(args) + '\\n');
if (args[2] === 'raw') {
  const payload = ${JSON.stringify(closePayload)};
  if (payload?.ok === true && ${closeExitCode} === 0 && ${JSON.stringify(closeStdout ?? null)} === null) {
    closed.push(JSON.parse(args[args.indexOf('--json-input') + 1]).sessionId);
    writeFileSync(closedPath, JSON.stringify(closed));
  }
  process.stdout.write(${JSON.stringify(closeStdout ?? null)} ?? JSON.stringify(payload));
  process.exitCode = ${closeExitCode};
} else {
  writeFileSync(${JSON.stringify(path.join(home, 'sdk-args.json'))}, JSON.stringify(args));
  const payload = ${JSON.stringify(payload)};
  if (Array.isArray(payload?.result?.sessions)) payload.result.sessions = payload.result.sessions.filter((entry) => !closed.includes(entry?.sessionId));
  process.stdout.write(JSON.stringify(payload));
}
`);
  await chmod(stub, 0o755);
  return stub;
}

/** 브로커가 없는 상태. 기존 테스트는 SDK 없이 돌던 그대로여야 한다. */
async function writeSdkOffStub(home) {
  return writeSdkStub(home, { ok: false, error: { code: "broker_unavailable", message: "no broker" } });
}

function sdkEntry({ id, repo, live = true, at = Date.now(), pid = 4242 }) {
  return {
    sessionId: id,
    locator: { cwd: repo, worktreeRoot: repo, stateRoot: `${repo}/.gjc/state` },
    endpointGeneration: 1,
    pid,
    live,
    deleted: false,
    indexSeq: 1,
    // live:false 인데 activity 가 남아있는 실측 잔여(12건)를 그대로 재현한다.
    activity: { state: "active", at },
    lastHeartbeatAt: at,
    identityProvenance: "composite",
  };
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

  const sdkStub = await writeSdkOffStub(home);
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SDK_CLI: sdkStub,
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

    const groupResponse = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ' Model group ' }),
    });
    assert.equal(groupResponse.status, 201);
    const { group } = await groupResponse.json();
    const emptyModelGroup = await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test&group=${group.id}`)).json();
    assert.deepEqual(emptyModelGroup.contributions, []);
    const membershipResponse = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [sessionId], member: true }),
    });
    assert.equal(membershipResponse.status, 200);
    const groupedModel = await (await fetch(`${baseUrl}/api/models/sessions?model=anthropic%2Fclaude-test&group=${group.id}`)).json();
    assert.deepEqual(groupedModel.contributions.map((entry) => entry.id), [sessionId]);

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
    assert.deepEqual(config.sessionGroups, [{ id: group.id, name: 'Model group', sessionIds: [] }]);
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
  const sdkStub = await writeSdkOffStub(home);
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SDK_CLI: sdkStub,
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
  const sdkStub = await writeSdkOffStub(home);
  const port = await availablePort();
  const server = spawn(process.execPath, ['--import', hookPath, 'server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SDK_CLI: sdkStub,
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
  const sdkStub = await writeSdkOffStub(home);
  const start = async (port) => spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, HOME: home, NODE_ENV: 'production', PORT: String(port), GJC_CODING_AGENT_DIR: agentDirectory, GJC_SESSION_DIR: sessionRoot, GJC_SDK_CLI: sdkStub },
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

/** SDK 오버레이 테스트용 최소 서버 기동 헬퍼. 세션 파일 하나와 SDK 응답을 주면 목록을 돌려준다. */
async function startOverlayServer({ home, sessions = [], sdkPayload, closeOptions }) {
  const agentDirectory = path.join(home, 'agent');
  const sessionRoot = path.join(home, 'sessions');
  for (const entry of sessions) {
    const directory = path.join(sessionRoot, entry.scope);
    await mkdir(path.join(directory, 'session'), { recursive: true });
    await writeFile(path.join(directory, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 4, id: entry.id, timestamp: entry.timestamp || '2026-08-10T01:00:00.000Z',
      cwd: entry.cwd || home, title: entry.title || '파일 세션',
    })}\n`);
  }
  const sdkStub = await writeSdkStub(home, sdkPayload, closeOptions);
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'production',
      PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory,
      GJC_SESSION_DIR: sessionRoot,
      GJC_SDK_CLI: sdkStub,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let listing = await waitForServer(baseUrl);
  for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
  }
  // 첫 요청은 캐시가 비어 있고 갱신은 뒤에서 돈다(응답을 절대 막지 않는 설계).
  // 그 첫 갱신이 스냅샷에 반영될 때까지 폴링한다.
  const wantsLive = (sdkPayload?.result?.sessions || []).some((entry) => entry.live === true);
  for (let attempt = 0; wantsLive && listing.summary.liveCount === 0 && attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
  }
  return { server, baseUrl, listing };
}

test('session close uses the broker and preserves file transcripts and config', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-close-'));
  const fileId = 'close-file';
  const sdkId = 'close-sdk";$(false)';
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [{ id: fileId, scope: 'scope' }],
    sdkPayload: { ok: true, result: { sessions: [fileId, sdkId].map((id) => sdkEntry({ id, repo: home })) } },
  });
  try {
    await fetch(`${baseUrl}/api/status/${fileId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
    });
    const transcriptPath = path.join(home, 'sessions', 'scope', 'session.jsonl');
    const configPath = path.join(home, '.gjc', 'session-list.json');
    const transcript = await readFile(transcriptPath, 'utf8');
    const config = await readFile(configPath, 'utf8');
    const before = await (await fetch(`${baseUrl}/api/sessions`)).json();
    for (const sessionId of [fileId, sdkId]) {
      const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { closed: true, sessionId });
    }
    const after = await (await fetch(`${baseUrl}/api/sessions`)).json();
    assert.equal(after.sessions.find((entry) => entry.id === fileId).live, false);
    assert.equal(after.sessions.some((entry) => entry.id === sdkId), false);
    assert.equal(after.summary.liveCount, 0);
    assert.notEqual(after.summary.modelRevision, before.summary.modelRevision);
    const detail = await (await fetch(`${baseUrl}/api/sessions/${fileId}`)).json();
    assert.equal(detail.live, false);
    assert.equal(detail.status, 'active');
    assert.equal((await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sdkId)}`)).status, 404);
    assert.equal(await readFile(transcriptPath, 'utf8'), transcript);
    assert.equal(await readFile(configPath, 'utf8'), config);
    const calls = (await readFile(path.join(home, 'sdk-invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const closes = calls.filter((args) => args[2] === 'raw');
    assert.equal(closes.length, 2);
    for (const [index, args] of closes.entries()) {
      assert.deepEqual(args.slice(0, 9), [
        'sdk', 'session', 'raw', 'global', '--op', 'session.close',
        '--json-input', JSON.stringify({ sessionId: [fileId, sdkId][index] }), '--idempotency-key',
      ]);
      assert.equal(args.length, 10);
      assert.match(args[9], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
    assert.notEqual(closes[0][9], closes[1][9]);
    assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['sdk', 'session', 'list', '--scope', 'all'])));
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('session close rejects unsafe targets, malformed IDs and unsupported methods', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-close-reject-'));
  const rows = [
    sdkEntry({ id: 'live', repo: home }),
    sdkEntry({ id: 'offline', repo: home, live: false }),
    { ...sdkEntry({ id: 'deleted', repo: home }), deleted: true },
    { ...sdkEntry({ id: 'uncertain', repo: home }), terminalUncertain: true },
    { ...sdkEntry({ id: 'ambiguous', repo: home }), ambiguous: true },
    sdkEntry({ id: 'duplicate', repo: home }),
    sdkEntry({ id: 'duplicate', repo: home }),
  ];
  const { server, baseUrl } = await startOverlayServer({
    home, sessions: [{ id: 'file-only', scope: 'scope' }],
    sdkPayload: { ok: true, result: { sessions: rows } },
  });
  try {
    for (const id of ['missing', 'file-only', 'offline', 'deleted']) {
      assert.equal((await fetch(`${baseUrl}/api/sessions/${id}/close`, { method: 'POST' })).status, 404);
    }
    for (const id of ['uncertain', 'ambiguous', 'duplicate']) {
      assert.equal((await fetch(`${baseUrl}/api/sessions/${id}/close`, { method: 'POST' })).status, 409);
    }
    for (const id of ['', '%', '%FF', 'a%2Fb', 'a/b', '%00', '%5C']) {
      const response = await fetch(`${baseUrl}/api/sessions/${id}/close`, { method: 'POST' });
      assert.equal(response.status, 400, id);
      assert.equal((await response.json()).code, 'malformed_session_id');
    }
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal((await fetch(`${baseUrl}/api/sessions/live/close`, { method })).status, 405);
    }
    // A live cached row must not authorize close once the current broker snapshot is offline.
    await writeSdkStub(home, { ok: true, result: { sessions: [sdkEntry({ id: 'live', repo: home, live: false })] } });
    assert.equal((await fetch(`${baseUrl}/api/sessions/live/close`, { method: 'POST' })).status, 404);
    await writeSdkOffStub(home);
    assert.equal((await fetch(`${baseUrl}/api/sessions/live/close`, { method: 'POST' })).status, 502);
    const calls = (await readFile(path.join(home, 'sdk-invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.some((args) => args[2] === 'raw'), false);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('session close requires a successful broker envelope and preserves live state on failure', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-close-fail-'));
  const sdkPayload = { ok: true, result: { sessions: [sdkEntry({ id: 'live', repo: home })] } };
  const { server, baseUrl } = await startOverlayServer({ home, sdkPayload });
  try {
    await writeSdkStub(home, sdkPayload, {
      closePayload: { ok: false, error: { code: 'terminal_uncertain' } },
      closeExitCode: 1,
    });
    const uncertain = await fetch(`${baseUrl}/api/sessions/live/close`, { method: 'POST' });
    assert.equal(uncertain.status, 409);
    assert.equal((await uncertain.json()).code, 'session_uncertain');

    for (const closeOptions of [
      { closePayload: { ok: false, error: { code: 'close_denied' } } },
      { closePayload: { result: { closed: true } } },
      { closeStdout: 'broken JSON' },
      { closeExitCode: 1 },
    ]) {
      await writeSdkStub(home, sdkPayload, closeOptions);
      const response = await fetch(`${baseUrl}/api/sessions/live/close`, { method: 'POST' });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, 'session_close_failed');
      const detail = await (await fetch(`${baseUrl}/api/sessions/live`)).json();
      assert.equal(detail.live, true);
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('groups validate, persist, and filter file and live SDK sessions', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-groups-'));
  const configPath = path.join(home, '.gjc', 'session-list.json');
  const fileId = 'group-file';
  const liveId = 'group-live';
  const deadId = 'group-dead';
  const savedId = '9d51d5d8-0000-4000-8000-000000000001';
  const duplicateId = '9d51d5d8-0000-4000-8000-000000000002';
  const unknownId = '9d51d5d8-0000-4000-8000-000000000003';
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    focusedSessionIds: [fileId],
    sessionGroups: [
      { id: savedId, name: ' Saved ', sessionIds: [fileId, fileId, 7, null, '', 'missing'] },
      { id: duplicateId, name: 'saved', sessionIds: [] },
      { id: savedId, name: 'Repeated ID', sessionIds: [] },
      { id: 'not-a-uuid', name: 'Bad ID', sessionIds: [] },
      { id: [unknownId], name: 'Non-string ID', sessionIds: [] },
      { id: unknownId, name: ' ', sessionIds: [] },
      { id: unknownId, name: 'x'.repeat(61), sessionIds: [] },
      { id: unknownId, name: 'Bad members', sessionIds: 'wrong' },
      null,
    ],
  }));
  const options = {
    home,
    sessions: [{ id: fileId, scope: 'scope' }],
    sdkPayload: { ok: true, result: { sessions: [
      { ...sdkEntry({ id: liveId, repo: home }), locator: { cwd: home } },
      sdkEntry({ id: deadId, repo: home, live: false }),
    ] } },
  };
  let running = await startOverlayServer(options);
  const request = (route, method, body) => fetch(`${running.baseUrl}${route}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const list = async (query = '') => (await fetch(`${running.baseUrl}/api/sessions${query}`)).json();
  try {
    assert.deepEqual((await list()).summary.groups, [{ id: savedId, name: 'Saved', sessionIds: [fileId, 'missing'], count: 1 }]);
    const created = await request('/api/groups', 'POST', { name: ' Current ' });
    assert.equal(created.status, 201);
    const { group } = await created.json();
    assert.match(group.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(group, { id: group.id, name: 'Current', sessionIds: [] });
    for (const name of ['', '  ', 'x'.repeat(61), 123, null]) {
      assert.equal((await request('/api/groups', 'POST', { name })).status, 400);
    }
    assert.equal((await request('/api/groups', 'POST', { name: 'CURRENT' })).status, 409);
    const racingCreates = await Promise.all([
      request('/api/groups', 'POST', { name: 'Race' }),
      request('/api/groups', 'POST', { name: 'race' }),
    ]);
    assert.deepEqual(racingCreates.map((response) => response.status).sort(), [201, 409]);
    const racingGroup = (await racingCreates.find((response) => response.status === 201).json()).group;
    await request(`/api/groups/${racingGroup.id}`, 'DELETE');
    assert.equal((await request('/api/groups', 'GET')).status, 405);
    assert.equal((await request(`/api/groups/${group.id}`, 'PUT', {})).status, 405);
    assert.equal((await request(`/api/groups/${group.id}/sessions`, 'POST', {})).status, 405);
    for (const id of ['bad', '%E0%A4%A', '']) {
      assert.equal((await request(`/api/groups/${id}`, 'DELETE')).status, 400);
    }
    assert.equal((await request(`/api/groups/${unknownId}`, 'DELETE')).status, 404);
    assert.equal((await request(`/api/groups/${unknownId}`, 'PATCH', { name: 'Missing' })).status, 404);
    for (const name of ['', '  ', 'x'.repeat(61), 123, null]) {
      const response = await request(`/api/groups/${group.id}`, 'PATCH', { name });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'invalid_name');
    }
    const duplicateRename = await request(`/api/groups/${group.id}`, 'PATCH', { name: ' SAVED ' });
    assert.equal(duplicateRename.status, 409);
    assert.equal((await duplicateRename.json()).code, 'duplicate_group_name');
    const malformedRename = await fetch(`${running.baseUrl}/api/groups/${group.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformedRename.status, 400);
    assert.equal((await malformedRename.json()).code, 'invalid_body');
    assert.equal((await request(`/api/groups/${group.id}`, 'POST', { name: 'Wrong method' })).status, 405);
    assert.equal((await request('/api/groups/bad', 'PATCH', { name: 'Invalid ID' })).status, 400);
    assert.equal((await request(`/api/groups/${unknownId}/sessions`, 'PUT', { ids: [fileId], member: true })).status, 404);
    assert.equal((await fetch(`${running.baseUrl}/api/sessions?group=bad`)).status, 400);
    assert.equal((await fetch(`${running.baseUrl}/api/sessions?group=${unknownId}`)).status, 404);
    const memberRoute = `/api/groups/${group.id}/sessions`;
    const malformed = await fetch(`${running.baseUrl}${memberRoute}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    for (const ids of [[], [123], [''], null, 'wrong']) {
      assert.equal((await request(memberRoute, 'PUT', { ids, member: true })).status, 400);
    }
    assert.equal((await request(memberRoute, 'PUT', { ids: [fileId], member: 'true' })).status, 400);
    for (const id of ['missing', deadId]) {
      assert.equal((await request(memberRoute, 'PUT', { ids: [fileId, id], member: true })).status, 404);
    }
    assert.equal((await list(`?group=${group.id}`)).resultCount, 0, 'invalid batches do not partially commit');
    const beforeFailure = (await list()).summary.modelRevision;
    await chmod(path.dirname(configPath), 0o500);
    let failedMembership;
    try {
      failedMembership = await request(memberRoute, 'PUT', { ids: [fileId], member: true });
    } finally {
      await chmod(path.dirname(configPath), 0o700);
    }
    assert.equal(failedMembership.status, 500);
    const afterFailure = await list(`?group=${group.id}`);
    assert.equal(afterFailure.resultCount, 0);
    assert.equal(afterFailure.summary.modelRevision, beforeFailure);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).sessionGroups.find((entry) => entry.id === group.id).sessionIds, []);
    const added = await request(memberRoute, 'PUT', { ids: [fileId, liveId, fileId], member: true });
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json()).group.sessionIds, [fileId, liveId]);
    const renameRoute = `/api/groups/${group.id}`;
    const beforeRenameFailure = await list();
    await chmod(path.dirname(configPath), 0o500);
    let failedRename;
    try {
      failedRename = await request(renameRoute, 'PATCH', { name: 'Not saved' });
    } finally {
      await chmod(path.dirname(configPath), 0o700);
    }
    assert.equal(failedRename.status, 500);
    const afterRenameFailure = await list();
    assert.deepEqual(afterRenameFailure.summary.groups, beforeRenameFailure.summary.groups);
    assert.equal(afterRenameFailure.summary.modelRevision, beforeRenameFailure.summary.modelRevision);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).sessionGroups.find((entry) => entry.id === group.id),
      { id: group.id, name: 'Current', sessionIds: [fileId, liveId] });
    const renamed = await request(renameRoute, 'PATCH', { name: ' Renamed ' });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await renamed.json()).group, { id: group.id, name: 'Renamed', sessionIds: [fileId, liveId] });
    assert.deepEqual((await list()).summary.groups.find((entry) => entry.id === group.id),
      { id: group.id, name: 'Renamed', sessionIds: [fileId, liveId], count: 2 });
    const renameRevision = (await list()).summary.modelRevision;
    assert.equal((await request(renameRoute, 'PATCH', { name: 'Renamed' })).status, 200);
    assert.equal((await list()).summary.modelRevision, renameRevision, 'no-op rename does not rotate revision');
    assert.equal((await request(renameRoute, 'PATCH', { name: 'RENAMED' })).status, 200, 'same group may change case');
    await request(`/api/archive/${fileId}`, 'PUT', { archived: true });
    const scoped = await list(`?group=${group.id}`);
    assert.deepEqual(scoped.sessions.map((session) => session.id), [liveId]);
    assert.equal(scoped.resultCount, 1);
    assert.equal(scoped.fileResultCount, 0);
    assert.equal(scoped.sdkOnlyCount, 1);
    assert.deepEqual(scoped.summary.archiveCounts, { current: 1, archived: 1, all: 2 });
    assert.deepEqual(scoped.summary.statusCounts, { none: 1, active: 0, done: 0 });
    assert.equal(scoped.summary.sessionCount, 1);
    assert.equal(scoped.summary.archivedSessionCount, 1);
    const archived = await list(`?group=${group.id}&archive=archived&status=active`);
    assert.deepEqual(archived.sessions.map((session) => session.id), [fileId]);
    assert.equal(archived.summary.statusCounts.active, 1);
    const summaryOnly = await list(`?group=${group.id}&summaryOnly=1&from=2099-01-01`);
    assert.equal(summaryOnly.resultCount, 0);
    assert.equal(summaryOnly.summary.sessionCount, 0);
    assert.deepEqual(summaryOnly.summary.groups, [
      { id: savedId, name: 'Saved', sessionIds: [fileId, 'missing'], count: 1 },
      { id: group.id, name: 'RENAMED', sessionIds: [fileId, liveId], count: 2 },
    ], 'group counts ignore group, date, status, and archive filters');
    assert.equal((await request(memberRoute, 'PUT', { ids: [fileId], member: false })).status, 200);
    assert.equal((await list(`?group=${group.id}&archive=all`)).summary.sessionCount, 0);
    const revision = (await list()).summary.modelRevision;
    await request(memberRoute, 'PUT', { ids: [liveId], member: true });
    assert.equal((await list()).summary.modelRevision, revision, 'no-op membership does not rotate revision');
    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(persisted.sessionGroups, [
      { id: savedId, name: 'Saved', sessionIds: [fileId, 'missing'] },
      { id: group.id, name: 'RENAMED', sessionIds: [liveId] },
    ]);
    assert.equal('focusedSessionIds' in persisted, false);
    running.server.kill('SIGTERM');
    await new Promise((resolve) => running.server.once('exit', resolve));
    running = await startOverlayServer(options);
    assert.deepEqual((await list()).summary.groups.find((entry) => entry.id === group.id),
      { id: group.id, name: 'RENAMED', sessionIds: [liveId], count: 1 });
    assert.deepEqual((await list(`?group=${group.id}`)).sessions.map((session) => session.id), [liveId]);
    assert.deepEqual(await (await request(`/api/groups/${group.id}`, 'DELETE')).json(), { removed: true });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).sessionGroups,
      [{ id: savedId, name: 'Saved', sessionIds: [fileId, 'missing'] }]);
  } finally {
    running.server.kill('SIGTERM');
    await new Promise((resolve) => running.server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('SDK 라이브 오버레이가 파일 세션에 live를 얹고 파일 없는 세션을 가상 행으로 올린다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-overlay-'));
  const liveId = '9d51d5d8-0000-4000-8000-00000000a001';
  const deadId = '9d51d5d8-0000-4000-8000-00000000a002';
  const orphanId = '9d51d5d8-0000-4000-8000-00000000a003';
  const orphanRepo = path.join(home, 'outside-repo');
  const at = Date.parse('2026-08-16T09:00:00.000Z');
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [
      { id: liveId, scope: 'live-scope', title: '살아있는 파일 세션' },
      { id: deadId, scope: 'dead-scope', title: '죽은 파일 세션' },
    ],
    sdkPayload: {
      ok: true,
      result: {
        version: 1,
        source: 'broker',
        sessions: [
          // 1) 라이브 + 파일 있음
          sdkEntry({ id: liveId, repo: home, live: true, at, pid: 111 }),
          // 2) 죽음 + 파일 있음 — activity 잔여가 있어도 live:false면 죽은 것이다
          sdkEntry({ id: deadId, repo: home, live: false, at, pid: 222 }),
          // 3) 라이브 + 파일 없음 → 가상 행
          sdkEntry({ id: orphanId, repo: orphanRepo, live: true, at, pid: 333 }),
        ],
      },
    },
  });

  try {
    const listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const byId = new Map(listing.sessions.map((session) => [session.id, session]));

    // 1) 라이브 + 파일 있음: 연결 여부만 붙고 실제 대화 시각은 파일 값을 유지한다.
    assert.equal(byId.get(liveId).live, true);
    assert.equal(byId.get(liveId).lastActivity, '2026-08-10T01:00:00.000Z');
    assert.equal(byId.get(liveId).sdkOnly, false);

    // 2) 죽음 + 파일 있음: live는 false이고 파일 기준 시각이 유지된다.
    assert.equal(byId.get(deadId).live, false);
    assert.notEqual(byId.get(deadId).lastActivity, new Date(at).toISOString());

    // 3) 라이브 + 파일 없음: 가상 행이 생긴다.
    const orphan = byId.get(orphanId);
    assert.equal(orphan.sdkOnly, true);
    assert.equal(orphan.live, true);
    assert.equal(orphan.filePath, '');
    assert.equal(orphan.totalTokens, 0);
    assert.equal(orphan.cwd, orphanRepo);

    // 카운트 분리: 파일 2 + 가상 1
    assert.equal(listing.resultCount, 3);
    assert.equal(listing.fileResultCount, 2);
    assert.equal(listing.sdkOnlyCount, 1);
    assert.equal(listing.summary.liveCount, 2);

    const refreshing = await (await fetch(`${baseUrl}/api/sessions?refresh=1`)).json();
    assert.equal(refreshing.summary.liveCheckHealthy, true);
    assert.equal(refreshing.summary.liveCount, listing.summary.liveCount);
    assert.equal(refreshing.summary.liveCheckedAt, listing.summary.liveCheckedAt);
    let refreshed = refreshing;
    for (let attempt = 0; refreshed.summary.liveCheckedAt === refreshing.summary.liveCheckedAt && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      refreshed = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    assert.ok(Date.parse(refreshed.summary.liveCheckedAt) > Date.parse(refreshing.summary.liveCheckedAt), 'refresh must complete a new SDK list call');
    assert.equal(refreshed.summary.liveCheckHealthy, true);

    // live 필터는 살아있는 것만 남긴다.
    const liveListing = await (await fetch(`${baseUrl}/api/sessions?live=1`)).json();
    assert.equal(liveListing.resultCount, 2);
    assert.ok(liveListing.sessions.every((session) => session.live));

    // 폴더 옵션에 가상 세션의 repo가 병합되고, 그 폴더로 거르면 가상 행이 남는다.
    const folder = listing.summary.folders.find((item) => item.cwd === orphanRepo);
    assert.ok(folder, '가상 세션의 repo가 폴더 옵션에 있어야 한다');
    assert.equal(folder.count, 1);
    const folderListing = await (await fetch(`${baseUrl}/api/sessions?folder=${encodeURIComponent(orphanRepo)}`)).json();
    assert.equal(folderListing.resultCount, 1);
    assert.equal(folderListing.sessions[0].id, orphanId);
    // 폴더 옆 개수가 실제 필터 결과와 일치해야 한다.
    assert.equal(folder.count, folderListing.resultCount);

    // 토큰·비용 총계는 파일 세션만 센다 — 가상 행이 집계를 오염시키지 않는다.
    assert.equal(listing.summary.totalTokens, 0);
    assert.equal(listing.summary.sessionCount, 2);

    // 가상 행: 상태·보관은 동작하고 제목 변경·삭제는 404다.
    const statusResponse = await fetch(`${baseUrl}/api/status/${orphanId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).session.status, 'active');

    const archiveResponse = await fetch(`${baseUrl}/api/archive/${orphanId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }),
    });
    assert.equal(archiveResponse.status, 200);

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${orphanId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '바꿀 수 없다' }),
    });
    assert.equal(renameResponse.status, 404);

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${orphanId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: orphanId }),
    });
    assert.equal(deleteResponse.status, 404);

    // 가상 행 상세는 GET으로 열린다.
    const detail = await fetch(`${baseUrl}/api/sessions/${orphanId}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).lastExchange, null);

    await writeSdkOffStub(home);
    let failed = await (await fetch(`${baseUrl}/api/sessions?refresh=1`)).json();
    for (let attempt = 0; failed.summary.liveCheckHealthy && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      failed = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    assert.equal(failed.summary.liveCheckHealthy, false, 'a failed refresh must not remain healthy');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('브로커가 ok:false면 500이 아니라 조용히 degrade한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-degrade-'));
  const sessionId = '9d51d5d8-0000-4000-8000-00000000b001';
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [{ id: sessionId, scope: 'scope', title: '파일 세션' }],
    sdkPayload: { ok: false, error: { code: 'broker_unavailable', message: 'no broker' } },
  });

  try {
    const response = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(response.status, 200);
    const listing = await response.json();
    assert.equal(listing.summary.liveCount, 0);
    assert.equal(listing.summary.liveCheckHealthy, false, 'an unavailable SDK must not imply a confirmed absence of connections');
    assert.equal(listing.resultCount, 1);
    assert.equal(listing.fileResultCount, 1);
    assert.equal(listing.sdkOnlyCount, 0);
    // live 키는 항상 존재하고 값은 false다.
    assert.equal(listing.sessions[0].live, false);
    assert.equal(listing.sessions[0].sdkOnly, false);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('가상 행에 찍은 상태는 그 세션의 파일이 생긴 뒤에도 그대로 이어진다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-transition-'));
  const sessionId = '9d51d5d8-0000-4000-8000-00000000c001';
  const at = Date.parse('2026-08-16T09:00:00.000Z');
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [],
    sdkPayload: {
      ok: true,
      result: {
        version: 1,
        source: 'broker',
        sessions: [sdkEntry({ id: sessionId, repo: home, live: true, at })],
      },
    },
  });

  try {
    const before = await (await fetch(`${baseUrl}/api/sessions`)).json();
    assert.equal(before.sessions.length, 1);
    assert.equal(before.sessions[0].sdkOnly, true);

    await fetch(`${baseUrl}/api/status/${sessionId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
    });

    // 세션이 이제 전사본을 쓴다. 같은 id의 파일이 생긴다.
    const directory = path.join(home, 'sessions', 'late-scope');
    await mkdir(path.join(directory, 'session'), { recursive: true });
    await writeFile(path.join(directory, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 4, id: sessionId, timestamp: '2026-08-16T09:00:00.000Z', cwd: home, title: '이제 파일이 생겼다',
    })}\n`);

    let after = await (await fetch(`${baseUrl}/api/sessions?refresh=1`)).json();
    for (let attempt = 0; after.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }

    // 같은 id가 두 줄로 늘어나지 않고 진짜 행 하나로 바뀐다.
    const rows = after.sessions.filter((session) => session.id === sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sdkOnly, false);
    assert.equal(rows[0].title, '이제 파일이 생겼다');
    // 가상 행일 때 찍어둔 상태가 살아남는다.
    assert.equal(rows[0].status, 'active');
    // 여전히 살아있으므로 live는 유지된다.
    assert.equal(rows[0].live, true);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('상세 조회와 변형 응답도 목록과 같은 live 오버레이를 얹는다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-detail-overlay-'));
  const sessionId = '9d51d5d8-0000-4000-8000-00000000d001';
  const at = Date.parse('2026-08-16T09:00:00.000Z');
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [{ id: sessionId, scope: 'scope', title: '살아있는 파일 세션' }],
    sdkPayload: {
      ok: true,
      result: { version: 1, source: 'broker', sessions: [sdkEntry({ id: sessionId, repo: home, live: true, at, pid: 777 })] },
    },
  });

  try {
    // 목록에 LIVE가 뜨는데 열면 없는 모순이 없어야 한다.
    const detail = await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json();
    assert.equal(detail.live, true);
    assert.equal(detail.pid, 777);

    // 상태를 바꿔도 그 행의 live가 사라지지 않아야 한다. 사라지면 배지가 깜빡인다.
    const statusResult = await (await fetch(`${baseUrl}/api/status/${sessionId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
    })).json();
    assert.equal(statusResult.session.live, true);

    const archiveResult = await (await fetch(`${baseUrl}/api/archive/${sessionId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }),
    })).json();
    assert.equal(archiveResult.session.live, true);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('브로커가 망가진 값을 줘도 목록은 200을 유지한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-garbage-'));
  const sessionId = '9d51d5d8-0000-4000-8000-00000000e001';
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [{ id: sessionId, scope: 'scope', title: '파일 세션' }],
    sdkPayload: {
      ok: true,
      result: {
        version: 1,
        source: 'broker',
        sessions: [
          // 시각이 문자열·NaN·음수, locator 없음, sessionId 없음/숫자, 중복 id — 전부 목록을 죽이면 안 된다.
          { sessionId: '9d51d5d8-0000-4000-8000-00000000e002', locator: { repo: home }, live: true, activity: { state: 'active', at: 'not-a-date' }, lastHeartbeatAt: 'nope' },
          { sessionId: '9d51d5d8-0000-4000-8000-00000000e003', live: true, activity: { state: 'active', at: Number.NaN } },
          { sessionId: '9d51d5d8-0000-4000-8000-00000000e004', locator: { repo: '' }, live: true, activity: { state: 'active', at: -1 } },
          { sessionId: null, locator: { repo: home }, live: true, activity: { state: 'active', at: Date.now() } },
          { sessionId: 12345, locator: { repo: home }, live: true, activity: { state: 'active', at: Date.now() } },
          { sessionId: '9d51d5d8-0000-4000-8000-00000000e005', locator: { repo: home }, live: true, activity: { state: 'active', at: Date.now() } },
          { sessionId: '9d51d5d8-0000-4000-8000-00000000e005', locator: { repo: home }, live: true, activity: { state: 'active', at: Date.now() } },
          null,
          'garbage',
        ],
      },
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(response.status, 200);
    const listing = await response.json();
    // 파일 세션은 무슨 일이 있어도 남는다.
    assert.ok(listing.sessions.some((session) => session.id === sessionId));
    // 어떤 행에도 Invalid Date가 새어나오지 않는다.
    for (const session of listing.sessions) {
      assert.notEqual(session.lastActivity, 'Invalid Date');
      assert.ok(session.lastActivity, '실행 중인 행은 안정적인 최초 감지 시각으로 보완한다');
      assert.ok(!Number.isNaN(Date.parse(session.lastActivity)));
    }
    // 중복 id는 한 줄로 접힌다.
    const dupes = listing.sessions.filter((session) => session.id === '9d51d5d8-0000-4000-8000-00000000e005');
    assert.equal(dupes.length, 1);
    // sessionId가 성하지 않은 항목은 행이 되지 않는다.
    assert.ok(!listing.sessions.some((session) => session.id === '12345' || !session.id));
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('브로커가 시각을 ISO 문자열로 줘도 실시간 값으로 인정한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-iso-'));
  const fileId = '9d51d5d8-0000-4000-8000-00000000f101';
  const orphanId = '9d51d5d8-0000-4000-8000-00000000f102';
  const iso = '2026-08-16T09:30:00.000Z';
  const { server, baseUrl } = await startOverlayServer({
    home,
    sessions: [{ id: fileId, scope: 'scope', title: '파일 세션' }],
    sdkPayload: {
      ok: true,
      result: {
        version: 1,
        source: 'broker',
        sessions: [
          // epoch ms 대신 ISO 문자열. 숫자로만 강제하면 이 값이 조용히 버려진다.
          { sessionId: fileId, locator: { repo: home }, live: true, pid: 501, activity: { state: 'active', at: iso }, lastHeartbeatAt: iso },
          { sessionId: orphanId, locator: { cwd: home, repo: '/wrong-legacy-repo' }, live: true, pid: 502, activity: { state: 'active', at: iso }, lastHeartbeatAt: iso },
        ],
      },
    },
  });

  try {
    const listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const byId = new Map(listing.sessions.map((session) => [session.id, session]));
    // 파일 세션: 하트비트는 실제 대화가 아니므로 세션 파일의 활동 시각을 유지한다.
    assert.equal(byId.get(fileId).lastActivity, '2026-08-10T01:00:00.000Z');
    // 가상 세션: 현재 시각 폴백이 아니라 준 시각 그대로여야 한다.
    assert.equal(byId.get(orphanId).lastActivity, iso);
    assert.equal(byId.get(orphanId).cwd, home);
    assert.equal(byId.get(orphanId).folderName, path.basename(home));
    assert.deepEqual(JSON.parse(await readFile(path.join(home, 'sdk-args.json'), 'utf8')),
      ['sdk', 'session', 'list', '--scope', 'all']);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('브로커의 대기·불확실·삭제 상태를 실행 상태와 구분한다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-state-'));
  const busyId = '9d51d5d8-0000-4000-8000-00000000f201';
  const idleId = '9d51d5d8-0000-4000-8000-00000000f202';
  const uncertainId = '9d51d5d8-0000-4000-8000-00000000f203';
  const deletedId = '9d51d5d8-0000-4000-8000-00000000f204';
  const idleAt = '2026-08-16T10:30:00.000Z';
  const { server, baseUrl } = await startOverlayServer({
    home,
    sdkPayload: {
      ok: true,
      result: {
        version: 2,
        source: 'broker',
        sessions: [
          { ...sdkEntry({ id: busyId, repo: home }), activity: { state: 'active', at: '2026-08-16T11:00:00.000Z' } },
          { ...sdkEntry({ id: idleId, repo: home, at: idleAt }), activity: { state: 'idle', at: idleAt }, ambiguous: true },
          { ...sdkEntry({ id: uncertainId, repo: home }), terminalUncertain: true },
          { ...sdkEntry({ id: deletedId, repo: home }), deleted: true },
        ],
      },
    },
  });

  try {
    const listing = await (await fetch(`${baseUrl}/api/sessions?live=1`)).json();
    const byId = new Map(listing.sessions.map((session) => [session.id, session]));
    assert.deepEqual([...byId.keys()].sort(), [busyId, idleId].sort());
    assert.equal(listing.summary.liveCount, 2);
    assert.equal(byId.get(busyId).busy, true);
    assert.equal(byId.get(idleId).busy, false);
    assert.equal(byId.get(idleId).ambiguous, true);
    assert.equal(byId.get(idleId).lastActivity, idleAt);
    assert.equal(byId.has(uncertainId), false);
    assert.equal(byId.has(deletedId), false);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('브로커 스텁이 깨진 JSON이나 비정상 종료를 내도 목록은 살아있다', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gjc-sdk-broken-'));
  const agentDirectory = path.join(home, 'agent');
  const sessionRoot = path.join(home, 'sessions');
  const sessionId = '9d51d5d8-0000-4000-8000-00000000f001';
  const directory = path.join(sessionRoot, 'scope');
  await mkdir(path.join(directory, 'session'), { recursive: true });
  await writeFile(path.join(directory, 'session.jsonl'), `${JSON.stringify({
    type: 'session', version: 4, id: sessionId, timestamp: '2026-08-10T01:00:00.000Z', cwd: home, title: '파일 세션',
  })}\n`);
  // 깨진 JSON을 뱉고 1로 죽는 스텁.
  const stub = path.join(home, 'broken-stub.mjs');
  await writeFile(stub, '#!/usr/bin/env node\nprocess.stdout.write("{not json");\nprocess.exit(1);\n');
  await chmod(stub, 0o755);

  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env, HOME: home, NODE_ENV: 'production', PORT: String(port),
      GJC_CODING_AGENT_DIR: agentDirectory, GJC_SESSION_DIR: sessionRoot, GJC_SDK_CLI: stub,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    let listing = await waitForServer(baseUrl);
    for (let attempt = 0; listing.summary.indexing && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      listing = await (await fetch(`${baseUrl}/api/sessions`)).json();
    }
    // 여러 번 불러 실패가 누적돼도(2회 연속 비우기 규칙) 목록은 그대로다.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/sessions`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.summary.liveCount, 0);
      assert.ok(body.sessions.some((session) => session.id === sessionId));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});
