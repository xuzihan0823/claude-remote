import { html, useCallback, useEffect, useMemo, useState } from '../../vendor/preact-htm-standalone.module.js';
import { cacheSessions, fetchSessions, pendingSessionMessages } from '../../core/api.js';
import { bus, useBus } from '../../core/bus.js';
import { ws } from '../../core/ws.js';
import { truncate } from '../utils.js';
import { useModelCatalog } from '../hooks.js';
import { NewChatComposer } from '../components/composer.js';
import { Spark } from '../components/spark.js';

export function StartScreen({ goChat, goSettings }) {
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了。' : hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。';
  const catalog = useModelCatalog();
  const [data, setData] = useState({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wsPhase, setWsPhase] = useState(ws.state.phase);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setData(await fetchSessions(500)); setError(''); }
    catch (e) { if (e.code !== 'unauthorized') setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useBus('ws-open', () => load(true), [load]);
  useBus('ws-state', ({ phase }) => setWsPhase(phase), []);
  useBus('ws:status', ({ sessionId, status }) => {
    setData((d) => ({ ...d, sessions: d.sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s)) }));
  }, []);

  const sessions = useMemo(() => [...data.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt), [data]);
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))], [sessions]);
  const created = useCallback((result, body) => {
    const summary = {
      sessionId: result.sessionId,
      cwd: body.cwd,
      title: truncate(body.text, 60),
      lastPreview: truncate(body.text, 80),
      lastActiveAt: Date.now(),
      sizeBytes: 0,
      status: 'daemon-driving',
    };
    cacheSessions([summary]);
    pendingSessionMessages.set(result.sessionId, body.text);
    ws.subscribe(result.sessionId);
    goChat(result.sessionId);
  }, [goChat]);

  return html`
    <div class="page home-page">
      <header class="home-topbar">
        <button class="home-circle-btn menu-btn" type="button" onClick=${() => bus.emit('drawer', true)} aria-label="打开侧栏" title="最近对话">☰</button>
        <span class="home-top-spacer"></span>
        <button class="home-circle-btn connection-button" type="button" onClick=${goSettings} aria-label="打开连接设置" title="连接设置">
          <span class="home-connection-dot ${wsPhase}"></span>
        </button>
      </header>
      <div class="home-body">
        <div class="home-heading">
          <${Spark} cls="welcome-spark" />
          <h1 class="serif">${greet}</h1>
        </div>
      </div>
      <footer class="home-dock">
        ${error && html`<div class="page-err home-err" onClick=${() => load()}>${error} · 点击重试</div>`}
        <${NewChatComposer} projects=${projects} catalog=${catalog} onCreated=${created} />
      </footer>
    </div>`;
}
