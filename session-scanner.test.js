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
    assert.match(session.preview, /고유한 검색어/);
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
    assert.equal(filterSessions(sessions, '검색어 gpt-test').length, 1);
    assert.equal(filterSessions(sessions, '없는말').length, 0);
    assert.equal(filterSessions(sessions, '', '/work/alpha').length, 1);
    assert.equal(filterSessions(sessions, '', '/work/other').length, 0);
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
