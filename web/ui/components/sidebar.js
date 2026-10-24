import { html, useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm-standalone.module.js';
import { connHost, fetchSessions, searchSessionsApi } from '../../core/api.js';
import { createSessionSearch, emptySearchState, MATCH_LABEL } from '../../core/search.js';
import { useBus } from '../../core/bus.js';
import { ws } from '../../core/ws.js';
import { cwdTail, relTime, STATUS_DOT } from '../utils.js';
import { Spark } from './spark.js';

export function Sidebar({ route, goList, goSettings, goChat }) {
  const [data, setData] = useState({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [, setTick] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await fetchSessions(100));
      setError('');
    } catch (e) {
      if (e.code !== 'unauthorized') setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t1 = setInterval(() => load(true), 30_000);
    const t2 = setInterval(() => setTick((x) => x + 1), 30_000);
    const vis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t1); clearInterval(t2); document.removeEventListener('visibilitychange', vis); };
  }, [load]);
  useBus('ws-open', () => load(true), [load]);
  useBus('ws:status', ({ sessionId, status }) => {
    setData((d) => ({ ...d, sessions: d.sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s)) }));
  }, []);

  const sorted = useMemo(() => [...data.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt), [data]);
  const [wsPhase, setWsPhase] = useState(ws.state.phase);
  useBus('ws-state', (s) => setWsPhase(s.phase), []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  useBus('drawer', setDrawerOpen, []);
  useEffect(() => { setDrawerOpen(false); }, [route.view, route.sessionId]);
  const nav = (fn) => () => { fn(); setDrawerOpen(false); };

  // ---- 搜索：先标题/路径/最近消息，再全文
  const [sq, setSq] = useState(emptySearchState);
  const searchRef = useRef(null);
  if (searchRef.current === null) searchRef.current = createSessionSearch(searchSessionsApi, setSq);
  useEffect(() => () => searchRef.current.dispose(), []);
  const searching = sq.query.trim() !== '';
  const hl = (text) => {
    const q = sq.query.trim().toLowerCase();
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0 || text.toLowerCase().length !== text.length) return text;
    return html`${text.slice(0, i)}<mark>${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
  };

  return html`
    <div class="sidebar-backdrop ${drawerOpen ? 'open' : ''}" onClick=${() => setDrawerOpen(false)}></div>
    <aside class="sidebar ${drawerOpen ? 'open' : ''}">
      <div class="side-head">
        <div class="brand serif"><${Spark} cls="brand-spark" />Claude Remote</div>
        <button class="icon-btn" title="刷新" onClick=${() => load()}>${loading ? html`<span class="spin">⟳</span>` : '⟳'}</button>
      </div>
      <nav class="side-nav">
        <button class="nav-item ${route.view === 'list' ? 'on' : ''}" onClick=${nav(goList)}>
          <span class="nav-ico">＋</span>新对话
        </button>
        <button class="nav-item ${route.view === 'settings' ? 'on' : ''}" onClick=${nav(goSettings)}>
          <span class="nav-ico">⚙</span>设置
        </button>
      </nav>
      <div class="side-search">
        <input type="search" placeholder="搜索对话" value=${sq.query} aria-label="搜索对话"
          onInput=${(e) => searchRef.current.setQuery(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Escape') searchRef.current.setQuery(''); }} />
      </div>
      ${searching ? html`
      <div class="side-scroll">
        ${sq.loading && html`<div class="empty">搜索中…</div>`}
        ${!sq.loading && !sq.fullLoading && !sq.error && sq.results.length === 0 && html`<div class="empty">没有找到相关对话</div>`}
        <ul class="session-list">
          ${sq.results.map((s) => html`
            <li key=${s.sessionId}
              class="session-item ${route.view === 'chat' && route.sessionId === s.sessionId ? 'active' : ''}"
              onClick=${nav(() => goChat(s.sessionId, s.match?.field === 'content' ? s.match.seq : undefined))}>
              <div class="row1">
                <span class="title">${s.match?.field === 'title' ? hl(s.title || '(空会话)') : (s.title || '(空会话)')}</span>
                <i class="dot ${STATUS_DOT[s.status] || ''}"></i>
              </div>
              ${s.match && s.match.field !== 'title' && html`<div class="row2 snippet">${MATCH_LABEL[s.match.field] || ''} · ${hl(s.match.snippet)}</div>`}
              <div class="row3">
                <span class="cwd">${cwdTail(s.cwd)}</span>
                <span class="sep">·</span><span>${relTime(s.lastActiveAt)}</span>
              </div>
            </li>`)}
        </ul>
        ${sq.error && html`<div class="page-err" onClick=${() => searchRef.current.retry()}>${sq.error} · 点击重试</div>`}
        ${sq.fullLoading && html`<div class="list-foot">正在搜索对话正文…</div>`}
        ${!sq.fullLoading && sq.truncated && html`<div class="list-foot">历史太多，只搜了最近的部分</div>`}
      </div>` : html`
      <div class="side-label">最近对话</div>
      <div class="side-scroll">
        ${error && html`<div class="page-err" onClick=${() => load()}>${error} · 点击重试</div>`}
        ${!loading && !error && sorted.length === 0 && html`<div class="empty">没有会话</div>`}
        <ul class="session-list">
          ${sorted.map((s) => html`
            <li key=${s.sessionId}
              class="session-item ${route.view === 'chat' && route.sessionId === s.sessionId ? 'active' : ''}"
              onClick=${nav(() => goChat(s.sessionId))}>
              <div class="row1">
                <span class="title">${s.title || '(空会话)'}</span>
                <i class="dot ${STATUS_DOT[s.status] || ''}"></i>
              </div>
              <div class="row3">
                <span class="cwd">${cwdTail(s.cwd)}</span>
                <span class="sep">·</span><span>${relTime(s.lastActiveAt)}</span>
              </div>
            </li>`)}
        </ul>
        ${data.total > sorted.length && html`<div class="list-foot">已显示 ${sorted.length} / ${data.total} 个会话</div>`}
      </div>`}
      <div class="side-foot">
        <span class="conn-dot ${wsPhase}"></span>
        <span class="ellip mono">${connHost()}</span>
      </div>
    </aside>`;
}
