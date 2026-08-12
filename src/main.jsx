import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import './styles.css';

const PAGE_SIZE = 50;
const PALETTE_LIMIT = 8;
const DEFAULT_PERIOD = '7d';
const PERIODS = [
  { value: '1d', label: '오늘' },
  { value: '3d', label: '최근 3일' },
  { value: '7d', label: '최근 1주' },
  { value: '30d', label: '최근 1개월' },
  { value: '90d', label: '최근 3개월' },
  { value: 'all', label: '전체 기간' },
  { value: 'custom', label: '직접 지정' },
];
const number = new Intl.NumberFormat('ko-KR');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const relativeTime = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

function formatRelative(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const ranges = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']];
  let value = seconds;
  for (const [divisor, unit] of ranges) {
    if (Math.abs(value) < divisor) return relativeTime.format(Math.round(value), unit);
    value /= divisor;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function splitModel(model) {
  if (!model) return { vendor: '', name: '' };
  const separator = model.lastIndexOf('/');
  if (separator === -1) return { vendor: '', name: model };
  return { vendor: model.slice(0, separator), name: model.slice(separator + 1) };
}

// 날짜 문자열을 로컬 하루 경계로 바꾼다. new Date('2026-08-01')은 UTC 자정이라
// UTC보다 뒤진 시간대에서 하루가 밀린다. 연·월·일을 직접 넘겨 그 함정을 피한다.
function localDayBound(dateString, endOfDay) {
  const [year, month, day] = dateString.split('-').map(Number);
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

/** 선택한 기간을 서버가 문자열로 비교할 수 있는 UTC ISO 구간으로 바꾼다. */
function periodRange(period, customFrom, customTo) {
  if (period === 'all') return { from: '', to: '' };
  if (period === 'custom') {
    return {
      from: customFrom ? localDayBound(customFrom, false).toISOString() : '',
      to: customTo ? localDayBound(customTo, true).toISOString() : '',
    };
  }
  const days = Number(period.replace('d', ''));
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: '' };
}

const STATUSES = [
  { value: 'active', label: '작업 중' },
  { value: 'done', label: '완료' },
];

/** 받침 유무에 따라 조사를 고른다. "완료으로"같은 틀린 표기를 막는다. */
function withParticle(word, afterConsonant, afterVowel) {
  const last = word.charCodeAt(word.length - 1);
  const hangul = last >= 0xac00 && last <= 0xd7a3;
  return `${word}${hangul && (last - 0xac00) % 28 !== 0 ? afterConsonant : afterVowel}`;
}

/** 긴 경로나 ID처럼 그대로 써야 하는 값. 복사 버튼을 붙인다. */
function CopyableValue({ label, value }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!value) return <dd>—</dd>;
  return (
    <dd>
      <code>{value}</code>
      <button
        type="button"
        aria-label={`${label} 복사`}
        data-state={copied ? 'success' : undefined}
        onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => {})}
      >
        {copied ? '복사됨' : '복사'}
      </button>
    </dd>
  );
}

/** Keep Tab cycling inside one dialog panel. */
function trapTabFocus(event, panel) {
  if (event.key !== 'Tab' || !panel) return;
  const focusable = [...panel.querySelectorAll('input, button:not(:disabled)')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Freeze background scrolling while a dialog is open; returns the restore callback. */
function lockBodyScroll() {
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => { document.body.style.overflow = previousOverflow; };
}

const SessionRow = memo(function SessionRow({ session, onOpen, onSetStatus }) {
  const model = splitModel(session.model);
  return (
    <article className={`session-row is-${session.status}`} id={`session-${session.id}`}>
      <button className="session-open" type="button" onClick={() => onOpen(session)} aria-label={`${session.title} 상세 정보 열기`}>
        <div className="session-main">
          <div className="session-code" aria-hidden="true">{session.folderName.slice(0, 2).toUpperCase()}</div>
          <div className="session-copy">
            <div className="session-title-line">
              <h2>{session.title}</h2>
              <span className="session-id">{session.id.slice(0, 8)}</span>
            </div>
            {session.preview ? <p>{session.preview}</p> : null}
            <span className="session-path" title={session.cwd}>{session.cwd || '작업 폴더 정보 없음'}</span>
          </div>
        </div>
        <dl className="session-metrics">
          <div><dt>최근 활동</dt><dd title={new Date(session.lastActivity).toLocaleString('ko-KR')}>{formatRelative(session.lastActivity)}</dd></div>
          <div><dt>메시지</dt><dd>{number.format(session.messageCount)}</dd></div>
          <div><dt>토큰</dt><dd>{session.totalTokens ? number.format(session.totalTokens) : '—'}</dd></div>
          <div><dt>비용</dt><dd>{session.cost ? money.format(session.cost) : '—'}</dd></div>
          <div><dt>파일</dt><dd>{formatBytes(session.size)}</dd></div>
        </dl>
        <div className="session-model" title={session.model || undefined}>
          <span>{model.vendor || '모델'}</span>
          <strong>{model.name || '정보 없음'}</strong>
        </div>
      </button>
      <div className="session-status">
        {STATUSES.map((item) => {
          const on = session.status === item.value;
          return (
            <button
              key={item.value}
              className={`session-mark is-${item.value}`}
              type="button"
              aria-pressed={on}
              aria-label={on ? `${session.title} ${item.label} 표시 해제` : `${session.title} ${withParticle(item.label, '으로', '로')} 표시`}
              onClick={() => onSetStatus(session.id, on ? 'none' : item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </article>
  );
});

function CommandPalette({ open, query, setQuery, sessions, activeIndex, setActiveIndex, onClose, onSelect, inputRef }) {
  const panelRef = useRef(null);
  const activeItemRef = useRef(null);
  const resultsRef = useRef(null);
  // 마우스 hover로 바뀐 선택까지 스크롤하면 커서 아래에서 목록이 튄다. 키보드 이동만 따라간다.
  const skipScrollRef = useRef(false);

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    // 첫 항목에서는 캡션까지 보이도록 맨 위로 붙인다.
    if (activeIndex === 0) resultsRef.current?.scrollTo({ top: 0 });
    else activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;
  return (
    <div className="command-layer" onKeyDown={(event) => trapTabFocus(event, panelRef.current)}>
      <button className="command-backdrop" type="button" onClick={onClose} aria-label="검색 닫기" />
      <section className="command-panel" id="command-palette" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="command-title">
        <h2 id="command-title" className="sr-only">세션 빠른 검색</h2>
        <div className="command-input">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목, 대화, 경로, 모델 검색" aria-controls="command-results" />
          <kbd>ESC</kbd>
        </div>
        <div className="command-results" id="command-results" ref={resultsRef}>
          <div className="command-caption"><span>{query ? '검색 결과' : '최근 세션'}</span><strong>{number.format(sessions.length)}</strong></div>
          {sessions.length ? sessions.map((session, index) => (
            <button
              key={session.id}
              ref={index === activeIndex ? activeItemRef : null}
              type="button"
              className={index === activeIndex ? 'command-item is-active' : 'command-item'}
              onMouseEnter={() => { skipScrollRef.current = true; setActiveIndex(index); }}
              onClick={() => onSelect(session)}
            >
              <span>{session.title}</span>
              <small>{session.folderName} · {formatRelative(session.lastActivity)}</small>
            </button>
          )) : <p className="command-empty">일치하는 세션이 없습니다.</p>}
        </div>
        <footer className="command-hints"><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span><span><kbd>↵</kbd> 선택</span><span><kbd>ESC</kbd> 닫기</span></footer>
      </section>
    </div>
  );
}

function SessionDetail({ selected, detail, loading, error, mutationDisabled, onClose, onRename, onDelete, onSetStatus }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const closeRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!selected) return undefined;
    setTitle(selected.title);
    setConfirmingDelete(false);
    setStatusSaving(false);
    setMutationError('');
    const restoreScroll = lockBodyScroll();
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreScroll();
    };
  }, [selected, onClose]);

  if (!selected) return null;
  const session = detail || selected;

  const rename = async (event) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === session.title) return;
    setSaving(true);
    setMutationError('');
    try {
      await onRename(session.id, nextTitle);
    } catch (renameError) {
      setMutationError(renameError.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setMutationError('');
    try {
      await onDelete(session.id);
    } catch (deleteError) {
      setMutationError(deleteError.message);
      setDeleting(false);
    }
  };

  const changeStatus = async (next) => {
    setStatusSaving(true);
    setMutationError('');
    try {
      await onSetStatus(session.id, next);
    } catch (statusError) {
      setMutationError(statusError.message);
    } finally {
      setStatusSaving(false);
    }
  };


  return (
    <div className="detail-layer">
      <button className="detail-backdrop" type="button" onClick={onClose} aria-label="상세 정보 닫기" />
      <section className="detail-panel" ref={panelRef} onKeyDown={(event) => trapTabFocus(event, panelRef.current)} role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <header className="detail-heading">
          <div><span>SESSION DETAIL</span><h2 id="detail-title">{session.title}</h2></div>
          <button ref={closeRef} className="detail-close" type="button" onClick={onClose} aria-label="상세 정보 닫기">×</button>
        </header>

        {loading ? <div className="detail-state">세션 원본을 읽고 있습니다.</div> : null}
        {error ? <div className="detail-state is-error">{error}</div> : null}
        {!loading && !error && detail ? (
          <div className="detail-content">
            <div className="detail-status" role="group" aria-label="세션 상태">
              {STATUSES.map((item) => {
                const on = session.status === item.value;
                return (
                  <button
                    key={item.value}
                    className={`session-mark is-${item.value}`}
                    type="button"
                    aria-pressed={on}
                    onClick={() => changeStatus(on ? 'none' : item.value)}
                    disabled={statusSaving || deleting}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
            <form className="rename-form" onSubmit={rename}>
              <label><span>세션 제목</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={saving || deleting || mutationDisabled} /></label>
              <button type="submit" disabled={saving || deleting || mutationDisabled || !title.trim() || title.trim() === session.title}>{saving ? '저장 중' : '제목 저장'}</button>
            </form>

            <dl className="detail-grid">
              <div><dt>세션 ID</dt><CopyableValue label="세션 ID" value={session.id} /></div>
              <div><dt>작업 폴더</dt><CopyableValue label="작업 폴더" value={session.cwd} /></div>
              <div><dt>세션 파일</dt><CopyableValue label="세션 파일" value={session.filePath} /></div>
              <div><dt>모델</dt><dd><code>{session.model || '—'}</code></dd></div>
              <div><dt>시작</dt><dd>{new Date(session.startedAt).toLocaleString('ko-KR')}</dd></div>
              <div><dt>최근 활동</dt><dd>{new Date(session.lastActivity).toLocaleString('ko-KR')}</dd></div>
              <div><dt>메시지</dt><dd>{number.format(session.messageCount)}</dd></div>
              <div><dt>토큰 · 비용</dt><dd>{number.format(session.totalTokens)} · {money.format(session.cost)}</dd></div>
            </dl>

            <section className="exchange">
              <h3>마지막 대화</h3>
              {detail.lastExchange?.user ? <div className="exchange-message"><span>USER</span><p>{detail.lastExchange.user.text}</p></div> : null}
              {detail.lastExchange?.assistant ? <div className="exchange-message is-assistant"><span>ASSISTANT</span><p>{detail.lastExchange.assistant.text}</p></div> : null}
              {!detail.lastExchange ? <p className="exchange-empty">텍스트 대화가 없습니다.</p> : null}
            </section>

            <section className="danger-zone">
              <div><h3>세션 삭제</h3><p>세션 기록과 연결된 아티팩트를 영구 삭제합니다.</p></div>
              {!confirmingDelete ? (
                <button type="button" onClick={() => setConfirmingDelete(true)} disabled={mutationDisabled}>삭제</button>
              ) : (
                <div className="delete-confirm">
                  <p>삭제 후 복구할 수 없습니다. 이 세션만 삭제합니다.</p>
                  <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting}>취소</button>
                  <button className="confirm-delete" type="button" onClick={remove} disabled={deleting}>{deleting ? '삭제 중' : '영구 삭제'}</button>
                </div>
              )}
            </section>

            {mutationDisabled ? <p className="mutation-message">인덱싱이 끝나면 제목 변경과 삭제를 사용할 수 있습니다.</p> : null}
            {mutationError ? <p className="mutation-message is-error" role="alert">{mutationError}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [folder, setFolder] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // 사이드바 숫자는 기간과 무관하게 전체 기준이라 요약과 별도로 든다.
  const [statusCounts, setStatusCounts] = useState({ active: 0, done: 0 });
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sessions, setSessions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [resultCount, setResultCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [directory, setDirectory] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [addingDirectory, setAddingDirectory] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const forceRefresh = useRef(false);
  const loadingMoreRef = useRef(false);
  const searchTriggerRef = useRef(null);
  const paletteInputRef = useRef(null);
  const listRef = useRef(null);
  const detailRequestRef = useRef(null);
  const detailTriggerRef = useRef(null);
  const listGenerationRef = useRef(0);

  const fetchPage = useCallback(async (offset, { append = false, force = false, signal, generation } = {}) => {
    const { from, to } = periodRange(period, customFrom, customTo);
    const params = new URLSearchParams({ q: deferredQuery, folder, status: statusFilter, from, to, offset: String(offset), limit: String(PAGE_SIZE) });
    if (force) params.set('refresh', '1');
    const response = await fetch(`/api/sessions?${params}`, { signal });
    if (!response.ok) throw new Error('세션을 불러오지 못했습니다.');
    const result = await response.json();
    if (generation !== listGenerationRef.current) return;
    setSummary(result.summary);
    setStatusCounts(result.summary.statusCounts);
    setResultCount(result.resultCount);
    setHasMore(result.hasMore);
    setNextOffset(result.nextOffset);
    setSessions((current) => {
      if (!append) return result.sessions;
      const existing = new Set(current.map((session) => session.id));
      return [...current, ...result.sessions.filter((session) => !existing.has(session.id))];
    });
  }, [deferredQuery, folder, statusFilter, period, customFrom, customTo]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++listGenerationRef.current;
    const force = forceRefresh.current;
    forceRefresh.current = false;
    setLoading(true);
    setSessions([]);
    setError('');
    fetchPage(0, { force, signal: controller.signal, generation })
      .catch((fetchError) => {
        if (fetchError.name !== 'AbortError') setError(fetchError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetchPage, requestKey]);

  useEffect(() => {
    if (!summary?.indexing) return undefined;
    const timer = setTimeout(async () => {
      const { from, to } = periodRange(period, customFrom, customTo);
      const params = new URLSearchParams({ q: deferredQuery, folder, status: statusFilter, from, to, summaryOnly: '1' });
      try {
        const result = await (await fetch(`/api/sessions?${params}`)).json();
        setSummary(result.summary);
        setStatusCounts(result.summary.statusCounts);
        setResultCount(result.resultCount);
      } catch {
        // The next list request will recover the status.
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [summary, deferredQuery, folder, statusFilter, period, customFrom, customTo]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      await fetchPage(nextOffset, { append: true, generation: listGenerationRef.current });
    } catch (fetchError) {
      setError(fetchError.message);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage, hasMore, nextOffset]);

  // 목록 시작 위치는 렌더가 아니라 레이아웃 이후에 잰다. 렌더 중 offsetTop 읽기는 매번 강제 리플로를 부른다.
  const [listOffset, setListOffset] = useState(0);

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return undefined;
    const measure = () => setListOffset((current) => (node.offsetTop === current ? current : node.offsetTop));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const rowVirtualizer = useWindowVirtualizer({
    count: sessions.length,
    estimateSize: () => 132,
    getItemKey: (index) => sessions[index]?.id ?? index,
    overscan: 8,
    scrollMargin: listOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualRows.at(-1);
    if (last && last.index >= sessions.length - 8) void loadMore();
  }, [virtualRows, sessions.length, loadMore]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    // inert 해제가 커밋된 뒤에 포커스를 돌려준다.
    requestAnimationFrame(() => searchTriggerRef.current?.focus());
  }, []);

  const openDetail = useCallback(async (session) => {
    detailTriggerRef.current = document.activeElement;
    setPaletteOpen(false);
    setSelected(session);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '상세 정보를 불러오지 못했습니다.');
      setDetail(result);
    } catch (detailFetchError) {
      if (detailFetchError.name !== 'AbortError') setDetailError(detailFetchError.message);
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  const paletteSessions = useMemo(() => sessions.slice(0, PALETTE_LIMIT), [sessions]);
  // 검색 결과가 줄어 선택이 범위를 벗어나면 하이라이트가 사라진다. 효과가 아니라 렌더에서 보정한다.
  const paletteActiveIndex = Math.min(activeIndex, Math.max(paletteSessions.length - 1, 0));

  // 열림 수명주기. activeIndex를 의존성에 두면 화살표로 옮긴 선택이 곧바로 0으로 되돌아간다.
  useEffect(() => {
    if (!paletteOpen) return undefined;
    setActiveIndex(0);
    paletteInputRef.current?.focus();
    return lockBodyScroll();
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closePalette();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, Math.max(paletteSessions.length - 1, 0)));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      }
      if (event.key === 'Enter' && paletteSessions[paletteActiveIndex]) {
        event.preventDefault();
        openDetail(paletteSessions[paletteActiveIndex]);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, paletteSessions, paletteActiveIndex, openDetail, closePalette]);

  useEffect(() => {
    const onShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, []);

  const closeDetail = useCallback(() => {
    detailRequestRef.current?.abort();
    setSelected(null);
    setDetail(null);
    const trigger = detailTriggerRef.current;
    detailTriggerRef.current = null;
    // 삭제로 닫힌 경우 원래 행은 사라졌으므로 복귀 대상이 없다.
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
  }, []);

  const applySessionUpdate = useCallback((sessionId, updated) => {
    setSessions((current) => current.map((session) => session.id === sessionId ? updated : session));
    setSelected((current) => current?.id === sessionId ? { ...current, ...updated } : current);
    setDetail((current) => current?.id === sessionId ? { ...current, ...updated } : current);
  }, []);

  const dropSession = useCallback((sessionId) => {
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setResultCount((current) => Math.max(0, current - 1));
    closeDetail();
  }, [closeDetail]);

  const renameSession = useCallback(async (sessionId, title) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '세션 제목을 변경하지 못했습니다.');

    applySessionUpdate(sessionId, result.session);
    return result.session;
  }, [applySessionUpdate]);

  const deleteSession = useCallback(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: sessionId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '세션을 삭제하지 못했습니다.');

    dropSession(sessionId);
    setStatusCounts(result.statusCounts);
    // 통계는 기간에 맞춰져 있으므로 서버가 다시 계산해야 맞는다.
    setRequestKey((key) => key + 1);
  }, [dropSession]);

  const setSessionStatus = useCallback(async (sessionId, next) => {
    const response = await fetch(`/api/status/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '상태를 변경하지 못했습니다.');

    // 상태로 걸러보는 중이라면 그 상태를 벗어난 세션은 목록에서 빠진다.
    if (statusFilter && result.session.status !== statusFilter) dropSession(sessionId);
    else applySessionUpdate(sessionId, result.session);
    setStatusCounts(result.statusCounts);
  }, [statusFilter, applySessionUpdate, dropSession]);

  const refresh = () => {
    forceRefresh.current = true;
    setRequestKey((key) => key + 1);
  };

  const addDirectory = async (event) => {
    event.preventDefault();
    if (!directory.trim()) return;
    setAddingDirectory(true);
    setDirectoryError('');
    try {
      const response = await fetch('/api/directories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: directory }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '폴더를 추가하지 못했습니다.');
      setDirectory('');
      setRequestKey((key) => key + 1);
    } catch (addError) {
      setDirectoryError(addError.message);
    } finally {
      setAddingDirectory(false);
    }
  };

  const progress = summary?.totalCount ? Math.round((summary.indexedCount / summary.totalCount) * 100) : 100;
  const sessionDirectories = summary?.sessionDirectories || [];
  const dialogOpen = paletteOpen || Boolean(selected);
  const scopeLabel = statusFilter
    ? STATUSES.find((item) => item.value === statusFilter).label
    : period === 'custom'
      ? `${customFrom || '처음'} ~ ${customTo || '지금'}`
      : PERIODS.find((item) => item.value === period).label;

  return (
    <div className="app-shell">
      {/* 모달이 열리면 배경을 inert로 잠근다. aria-modal만으로는 스크린리더가 배경에 닿는 경우가 있다. */}
      <div inert={dialogOpen || undefined}>
      <nav className="topbar" aria-label="주요 탐색">
        <a className="wordmark" href="#top" aria-label="GJC Sessions 처음으로"><span>GJC</span> / SESSIONS</a>
        <button className="search-trigger" type="button" ref={searchTriggerRef} onClick={() => setPaletteOpen(true)} aria-expanded={paletteOpen} aria-controls="command-palette">
          <span aria-hidden="true">⌕</span><span>{query || '세션 검색'}</span><kbd>⌘ K</kbd>
        </button>
        <div className="topbar-actions">
          <span className={summary?.indexing ? 'system-status is-busy' : 'system-status'}><i /> {summary?.indexing ? `인덱싱 ${progress}%` : 'INDEX READY'}</span>
          <button className="refresh-button" type="button" onClick={refresh} disabled={loading} aria-busy={loading}>{loading ? '확인 중' : '다시 스캔'}</button>
        </div>
      </nav>

      <main id="top">
        <header className="index-header">
          <div><p>로컬 작업 기록</p><h1>세션 인덱스</h1></div>
          <p className="index-intro">작업 폴더마다 흩어진 GJC 세션을 제목, 대화 내용, 모델과 경로로 찾습니다.</p>
        </header>

        <section className="readout" aria-label="세션 통계">
          <div><span>세션</span><strong>{summary ? number.format(summary.sessionCount) : '—'}</strong></div>
          <div><span>작업 폴더</span><strong>{summary ? number.format(summary.folderCount) : '—'}</strong></div>
          <div><span>메시지</span><strong>{summary ? number.format(summary.totalMessages) : '—'}</strong></div>
          <div><span>토큰</span><strong>{summary?.totalTokens ? number.format(summary.totalTokens) : '—'}</strong></div>
          <div><span>비용</span><strong>{summary?.totalCost ? money.format(summary.totalCost) : '—'}</strong></div>
        </section>

        {summary?.indexing ? <div className="index-progress" role="status"><span style={{ width: `${progress}%` }} /><p>목록 사용 가능 · 대화 검색 인덱스 {number.format(summary.indexedCount)}/{number.format(summary.totalCount)}</p></div> : null}

        <div className="workspace">
          <aside className="filters">
            <section>
              <h2>범위</h2>
              <div className="status-filters" role="group" aria-label="상태로 걸러보기">
                {STATUSES.map((item) => (
                  <button
                    key={item.value}
                    className={`status-filter is-${item.value}`}
                    type="button"
                    aria-pressed={statusFilter === item.value}
                    onClick={() => setStatusFilter((current) => (current === item.value ? '' : item.value))}
                  >
                    <span>{item.label}</span><strong>{number.format(statusCounts[item.value])}</strong>
                  </button>
                ))}
              </div>
              <label>
                <span>기간</span>
                <span className="select-shell">
                  <select value={period} onChange={(event) => setPeriod(event.target.value)} disabled={Boolean(statusFilter)}>
                    {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </span>
              </label>
              {period === 'custom' && !statusFilter ? (
                <div className="date-range">
                  <label>
                    <span>시작</span>
                    <input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} />
                  </label>
                  <label>
                    <span>종료</span>
                    <input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} />
                  </label>
                </div>
              ) : null}
              {statusFilter ? <p className="scope-note">상태로 걸러볼 때는 기간과 무관하게 모두 보여줍니다.</p> : null}
              <label>
                <span>작업 폴더</span>
                <span className="select-shell">
                  <select value={folder} onChange={(event) => setFolder(event.target.value)}>
                    <option value="">모든 작업 폴더</option>
                    {summary?.folders.map((item) => <option key={item.cwd} value={item.cwd}>{item.name} · {item.count}</option>)}
                  </select>
                </span>
              </label>
              {query ? <button className="clear-filter" type="button" onClick={() => setQuery('')}>검색어 “{query}” 지우기</button> : null}
            </section>
            <section>
              <h2>저장소</h2>
              <ul className="repository-list">{sessionDirectories.map((item) => <li key={item} title={item}>{item}</li>)}</ul>
              <form className="directory-form" onSubmit={addDirectory}>
                <label><span>세션 경로 추가</span><input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="~/work/gjc-sessions" aria-invalid={Boolean(directoryError)} aria-describedby="directory-message" /></label>
                <button type="submit" disabled={addingDirectory || !directory.trim()}>{addingDirectory ? '경로 확인 중' : '경로 추가'}</button>
                <p id="directory-message" className={directoryError ? 'is-error' : undefined} role={directoryError ? 'alert' : undefined}>{directoryError || 'JSONL 세션이 저장된 폴더를 입력하세요.'}</p>
              </form>
            </section>
          </aside>

          <section className="session-index" aria-busy={loading}>
            <header className="results-heading"><div role="status"><strong>{number.format(resultCount)}</strong><span>개 세션</span></div><span>{scopeLabel} · 최근 활동순</span></header>
            {error ? <div className="empty-state is-error" role="alert">{error}</div> : null}
            {!error && loading ? <div className="empty-state">세션 목록을 불러오고 있습니다.</div> : null}
            {!error && !loading && sessions.length === 0 ? <div className="empty-state">{statusFilter ? `${withParticle(scopeLabel, '으로', '로')} 표시한 세션이 없습니다.` : `${scopeLabel}에 해당하는 세션이 없습니다.`}</div> : null}
            <div ref={listRef} className="virtual-list" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              {virtualRows.map((virtualRow) => {
                const session = sessions[virtualRow.index];
                return (
                  <div key={virtualRow.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} className="virtual-row" style={{ transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)` }}>
                    <SessionRow session={session} onOpen={openDetail} onSetStatus={setSessionStatus} />
                  </div>
                );
              })}
            </div>
            {loadingMore ? <div className="load-more" role="status">다음 세션을 불러오는 중</div> : null}
            {!hasMore && sessions.length > 0 ? <div className="list-end">{number.format(resultCount)}개 세션을 모두 불러왔습니다.</div> : null}
          </section>
        </div>
      </main>

      <footer className="page-footer"><span>LOCAL ONLY</span><span>{sessionDirectories.length}개 저장소</span><span>{summary?.scannedAt ? `마지막 확인 ${formatRelative(summary.scannedAt)}` : '저장소 확인 중'}</span></footer>
      </div>

      <CommandPalette open={paletteOpen} query={query} setQuery={setQuery} sessions={paletteSessions} activeIndex={paletteActiveIndex} setActiveIndex={setActiveIndex} onClose={closePalette} onSelect={openDetail} inputRef={paletteInputRef} />
      <SessionDetail selected={selected} detail={detail} loading={detailLoading} error={detailError} mutationDisabled={summary?.indexing} onClose={closeDetail} onRename={renameSession} onDelete={deleteSession} onSetStatus={setSessionStatus} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
