import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverSessions, filterSessions, indexSessionFiles, parseSessionDetail, parseSessionFile } from './session-scanner.js';

/** Run the production two-phase path: discover headers, then index the pending files. */
async function indexAll(directories) {
  const { pendingFiles } = await discoverSessions(directories);
  const sessions = [];
  await indexSessionFiles(pendingFiles, (session) => sessions.push(session));
  return sessions;
}

const entries = [
  { type: 'session', id: 'session-123', timestamp: '2026-08-10T01:00:00.000Z', cwd: '/work/alpha', title: '검색 기능 구현' },
  { type: 'model_change', timestamp: '2026-08-10T01:01:00.000Z', model: 'openai/gpt-test' },
  { type: 'message', timestamp: '2026-08-10T01:02:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '고유한 검색어로 찾아줘' }] } },
  { type: 'message', timestamp: '2026-08-10T01:03:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '완료했습니다.' }], usage: { totalTokens: 42, cost: { total: 0.25 } } } },
];

test('세션 메타데이터와 사용량을 JSONL에서 읽는다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-sessions-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, `${entries.map(JSON.stringify).join('\n')}\n잘못된 줄\n`);

  try {
    const session = await parseSessionFile(file);
    assert.equal(session.id, 'session-123');
    assert.equal(session.folderName, 'alpha');
    assert.equal(session.model, 'openai/gpt-test');
    assert.equal(session.messageCount, 2);
    assert.equal(session.totalTokens, 42);
    assert.equal(session.cost, 0.25);
    assert.deepEqual(session.models, [{ id: 'openai/gpt-test', responses: 1, tokens: 42, cost: 0.25 }], '모델이 안 적힌 응답은 그 시점 세션 모델로 잡는다');
    assert.match(session.preview, /고유한 검색어/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('모델을 갈아탄 세션의 사용량을 응답에 적힌 모델별로 나눈다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-models-'));
  const file = path.join(directory, 'session.jsonl');
  const answer = (timestamp, provider, model, totalTokens, total) => ({
    type: 'message',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text: '응답' }], provider, model, usage: { totalTokens, cost: { total } } },
  });
  const mixed = [
    entries[0],
    answer('2026-08-10T01:00:30.000Z', '', '', 25, 0.25),
    entries[1],
    answer('2026-08-10T01:02:00.000Z', 'anthropic', 'claude-test', 100, 1),
    { type: 'model_change', timestamp: '2026-08-10T01:03:00.000Z', model: 'openai-codex/gpt-test-2' },
    answer('2026-08-10T01:04:00.000Z', 'openai-codex', 'gpt-test-2', 300, 2),
    answer('2026-08-10T01:05:00.000Z', 'anthropic', 'claude-test', 50, 0.5),
  ];
  await writeFile(file, mixed.map(JSON.stringify).join('\n'));

  try {
    const session = await parseSessionFile(file);
    assert.equal(session.totalTokens, 475);
    assert.deepEqual(session.models, [
      { id: 'openai-codex/gpt-test-2', responses: 1, tokens: 300, cost: 2 },
      { id: 'anthropic/claude-test', responses: 2, tokens: 150, cost: 1.5 },
      { id: '', responses: 1, tokens: 25, cost: 0.25 },
    ], '같은 모델은 합치고 토큰이 많은 쪽이 앞에 온다');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('서브에이전트 전사본의 사용량을 부모 세션에 합산한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-subagent-'));
  const file = path.join(directory, 'session.jsonl');
  const artifacts = path.join(directory, 'session');
  const nested = path.join(artifacts, '0-Planner');
  await mkdir(nested, { recursive: true });
  await writeFile(file, entries.map(JSON.stringify).join('\n'));
  // 서브에이전트 전사본은 그 자체가 세션 파일 모양이고, 서브에이전트가 또 부른 것은 한 단 더 중첩된다.
  const transcript = (id, model, totalTokens, total) => [
    { type: 'session', id, timestamp: '2026-08-10T01:03:00.000Z', cwd: '/work/alpha', title: id },
    { type: 'message', timestamp: '2026-08-10T01:04:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '서브 응답' }], provider: 'anthropic', model, usage: { totalTokens, cost: { total } } } },
  ].map(JSON.stringify).join('\n');
  await writeFile(path.join(artifacts, '0-Planner.jsonl'), transcript('sub-1', 'claude-sonnet-test', 700, 0.7));
  await writeFile(path.join(nested, 'deep.jsonl'), transcript('sub-2', 'claude-sonnet-test', 300, 0.3));

  try {
    const session = await parseSessionFile(file);
    assert.equal(session.subagentTokens, 1000);
    assert.equal(session.totalTokens, 1042, '본문 42 + 서브에이전트 1000');
    assert.equal(session.messageCount, 2, '서브에이전트 메시지는 대화 길이를 부풀리지 않는다');
    assert.deepEqual(session.models, [
      { id: 'anthropic/claude-sonnet-test', responses: 2, tokens: 1000, cost: 1 },
      { id: 'openai/gpt-test', responses: 1, tokens: 42, cost: 0.25 },
    ]);
    assert.equal(session.searchText.includes('서브 응답'), false, '전사본 본문은 검색 인덱스에 넣지 않는다');
    assert.equal(filterSessions([session], { query: 'claude-sonnet-test' }).length, 1, '서브에이전트 전용 모델도 이름으로 찾힌다');

    // 세션 파일은 그대로인데 서브에이전트만 길어진 경우도 다시 읽어야 한다.
    const fresh = await discoverSessions([directory], [session]);
    assert.equal(fresh.pendingFiles.length, 0, '그대로면 재인덱싱하지 않는다');
    await writeFile(path.join(artifacts, '1-Critic.jsonl'), transcript('sub-3', 'claude-sonnet-test', 5, 0.05));
    const stale = await discoverSessions([directory], [session]);
    assert.deepEqual(stale.pendingFiles, [file], '전사본이 늘어나면 캐시를 버린다');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('중첩 폴더를 스캔하고 여러 검색어와 폴더를 함께 필터링한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-sessions-'));
  const nested = path.join(directory, 'encoded-path');
  await mkdir(nested);
  await writeFile(path.join(nested, 'session.jsonl'), entries.map(JSON.stringify).join('\n'));

  try {
    const sessions = await indexAll([directory]);
    assert.equal(sessions.length, 1);
    assert.equal(filterSessions(sessions, { query: '검색어 gpt-test' }).length, 1);
    assert.equal(filterSessions(sessions, { query: '없는말' }).length, 0);
    assert.equal(filterSessions(sessions, { folder: '/work/alpha' }).length, 1);
    assert.equal(filterSessions(sessions, { folder: '/work/other' }).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('여러 저장소의 메타데이터를 먼저 반환하고 캐시된 파일은 재인덱싱하지 않는다', async () => {
  const firstDirectory = await mkdtemp(path.join(tmpdir(), 'gjc-sessions-a-'));
  const secondDirectory = await mkdtemp(path.join(tmpdir(), 'gjc-sessions-b-'));
  const secondEntries = entries.map((entry) => (
    entry.type === 'session' ? { ...entry, id: 'session-456', cwd: '/work/beta' } : entry
  ));
  await writeFile(path.join(firstDirectory, 'first.jsonl'), entries.map(JSON.stringify).join('\n'));
  await writeFile(path.join(secondDirectory, 'second.jsonl'), secondEntries.map(JSON.stringify).join('\n'));

  try {
    const discovered = await discoverSessions([firstDirectory, secondDirectory]);
    assert.equal(discovered.sessions.length, 2);
    assert.equal(discovered.pendingFiles.length, 2);
    assert.equal(discovered.sessions.every((session) => !session.indexed), true);

    const indexed = await indexAll([firstDirectory, secondDirectory]);
    const cached = await discoverSessions([firstDirectory, secondDirectory], indexed);
    assert.equal(cached.sessions.length, 2);
    assert.equal(cached.pendingFiles.length, 0);
    assert.equal(cached.sessions.every((session) => session.indexed), true);
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('상세 조회에서 마지막 사용자와 어시스턴트 대화를 반환한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-detail-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, entries.map(JSON.stringify).join('\n'));

  try {
    const detail = await parseSessionDetail(file);
    assert.equal(detail.id, 'session-123');
    assert.equal(detail.model, 'openai/gpt-test');
    assert.equal(detail.lastExchange.user.text, '고유한 검색어로 찾아줘');
    assert.equal(detail.lastExchange.assistant.text, '완료했습니다.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('header_patch로 변경된 제목을 목록과 상세 조회에 반영한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-header-patch-'));
  const file = path.join(directory, 'session.jsonl');
  const renamedEntries = [
    ...entries,
    { type: 'header_patch', timestamp: '2026-08-10T01:04:00.000Z', patch: { title: '변경된 세션 제목', titleSource: 'user' } },
  ];
  await writeFile(file, renamedEntries.map(JSON.stringify).join('\n'));

  try {
    const [session, detail] = await Promise.all([parseSessionFile(file), parseSessionDetail(file)]);
    assert.equal(session.title, '변경된 세션 제목');
    assert.equal(detail.title, '변경된 세션 제목');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('같은 세션이 두 저장소에 남아 있으면 최근 사본만 목록에 올린다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-migrated-'));
  const legacy = path.join(directory, '-Users-me-project');
  const current = path.join(directory, 'v2-hashed');
  await mkdir(legacy, { recursive: true });
  await mkdir(current, { recursive: true });
  // 마이그레이션 전후 사본. 신형 쪽에 대화가 더 쌓여 있다.
  await writeFile(path.join(legacy, 'session.jsonl'), entries.map(JSON.stringify).join('\n'));
  await writeFile(path.join(current, 'session.jsonl'), [
    ...entries,
    { type: 'message', timestamp: '2026-08-10T02:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '이어서' }] } },
  ].map(JSON.stringify).join('\n'));

  try {
    const { sessions, pendingFiles, copyPathsById } = await discoverSessions([directory]);
    assert.equal(sessions.length, 1, '같은 id는 한 줄만 남는다');
    assert.equal(sessions[0].filePath, path.join(current, 'session.jsonl'), '최근 활동이 늦은 사본을 고른다');
    assert.deepEqual(pendingFiles, [path.join(current, 'session.jsonl')], '버린 사본은 인덱싱하지 않는다');
    assert.deepEqual(copyPathsById.get(entries[0].id), [
      path.join(legacy, 'session.jsonl'),
      path.join(current, 'session.jsonl'),
    ].sort(), '목록 승자와 별개로 삭제용 모든 사본 경로를 보존한다');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('기간 구간으로 세션을 걸러낸다', () => {
  const sessions = [
    { lastActivity: '2026-08-01T10:00:00.000Z', cwd: '', searchText: 'a' },
    { lastActivity: '2026-08-05T10:00:00.000Z', cwd: '', searchText: 'b' },
    { lastActivity: '2026-08-09T10:00:00.000Z', cwd: '', searchText: 'c' },
  ];

  assert.equal(filterSessions(sessions, { from: '2026-08-04T00:00:00.000Z' }).length, 2);
  assert.equal(filterSessions(sessions, { to: '2026-08-04T00:00:00.000Z' }).length, 1);
  assert.equal(
    filterSessions(sessions, { from: '2026-08-02T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' }).length,
    1,
  );
  assert.equal(filterSessions(sessions, {}).length, 3);
  assert.equal(filterSessions(sessions, { from: '2026-08-05T10:00:00.000Z' }).length, 2, '경계는 포함이다');
});

test('세션 파일과 같은 이름의 아티팩트 디렉터리는 탐색에서 제외한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-artifacts-'));
  const scope = path.join(directory, 'v2-scope');
  const sessionName = '2026-08-10T01-00-00-000Z_session-123';
  const artifacts = path.join(scope, sessionName);
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(scope, `${sessionName}.jsonl`), entries.map(JSON.stringify).join('\n'));
  // 서브에이전트 트랜스크립트. 독립 세션처럼 보이지만 목록에 들어가면 안 된다.
  await writeFile(path.join(artifacts, '0-Planner.jsonl'), entries.map(JSON.stringify).join('\n'));
  await mkdir(path.join(artifacts, '1-Architect'), { recursive: true });
  await writeFile(path.join(artifacts, '1-Architect', 'deep.jsonl'), entries.map(JSON.stringify).join('\n'));

  try {
    const { sessions } = await discoverSessions([directory]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].filePath, path.join(scope, `${sessionName}.jsonl`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
