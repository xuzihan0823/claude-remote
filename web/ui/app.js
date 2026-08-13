import { html, render, useCallback, useEffect, useState } from '../vendor/preact-htm-standalone.module.js';
import {
  BASE_KEY, TOKEN_KEY, baseUrl, clearToken, connErrMsg, connHost, loadBases,
  normalizeBase, probeBases, saveBases, saveConn, token, api,
} from '../core/api.js';
import { toast, useBus } from '../core/bus.js';
import { ws } from '../core/ws.js';
import { useVVH } from './hooks.js';
import { ApprovalLayer } from './components/approval.js';
import { ConnBar } from './components/conn-bar.js';
import { Sidebar } from './components/sidebar.js';
import { ToastLayer } from './components/toast.js';
import { Chat } from './screens/chat.js';
import { StartScreen } from './screens/home.js';
import { PairPage } from './screens/pair.js';
import { SettingsPage } from './screens/settings.js';
import { PairConfirm, SetupGate } from './screens/setup.js';

export function parseHash() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/s\/(.+)$/);
  if (m) return { view: 'chat', sessionId: decodeURIComponent(m[1]) };
  if (h === '#/settings') return { view: 'settings' };
  if (h === '#/pair') return { view: 'pair' };
  return { view: 'list' };
}
const goChat = (id) => { location.hash = `#/s/${encodeURIComponent(id)}`; };
const goList = () => { location.hash = '#/'; };
const goSettings = () => { location.hash = '#/settings'; };

export function parseSetupLink(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'claude-remote:') return null;
  const where = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '');
  if (where !== 'setup') return null;
  const params = {};
  for (const kv of (u.search.startsWith('?') ? u.search.slice(1) : u.search).split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  let tok = '';
  let bases = [];
  try {
    tok = decodeURIComponent(params.token || '');
    bases = (params.bases || '').split(',').filter(Boolean)
      .map((s) => normalizeBase(decodeURIComponent(s))).filter(Boolean);
  } catch { return null; }
  if (!tok || bases.length === 0) return null;
  return { token: tok, bases };
}

export function App() {
  useVVH();
  // 点空白处收起键盘：焦点在输入框且触摸目标不是交互元素时 blur（浏览器/壳内通用）
  useEffect(() => {
    const h = (e) => {
      const ae = document.activeElement;
      if (!ae || (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT')) return;
      if (e.target.closest('input, textarea, select, button, a, label, [contenteditable]')) return;
      ae.blur();
    };
    document.addEventListener('touchstart', h, { passive: true });
    return () => document.removeEventListener('touchstart', h);
  }, []);
  const [auth, setAuth] = useState(token ? 'checking' : 'need');
  const [authErr, setAuthErr] = useState('');
  const [route, setRoute] = useState(parseHash());

  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  useBus('unauthorized', () => {
    ws.stop();
    clearToken();
    localStorage.removeItem(TOKEN_KEY);
    setAuth('need');
    setAuthErr('token 已失效，请重新输入');
  }, []);
  useBus('logout', () => {
    ws.stop();
    saveConn('', '');
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(BASE_KEY);
    goList();
    setAuth('need');
    setAuthErr('');
  }, []);

  const tryConnect = useCallback(async (base, tok) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    const prevBase = baseUrl;
    const prevToken = token;
    saveConn(base, tok);
    try {
      await api('/api/health');
      setAuth('ok');
      ws.stop();
      ws.start();
      return true;
    } catch (e) {
      saveConn(prevBase, prevToken);
      const msg = connErrMsg(e);
      if (auth !== 'ok') { setAuth('need'); setAuthErr(msg); }
      toast(msg, 'error');
      return false;
    }
  }, [auth]);

  const tryConnectBases = useCallback(async (bases, tok) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    try {
      const base = await probeBases(bases, tok);
      saveBases(bases);
      saveConn(base, tok);
      setAuth('ok');
      ws.stop();
      ws.start();
      return true;
    } catch (e) {
      const msg = connErrMsg(e);
      if (auth !== 'ok') { setAuth('need'); setAuthErr(msg); }
      toast(msg, 'error');
      return false;
    }
  }, [auth]);

  const [pairReq, setPairReq] = useState(null);
  const [pairBusy, setPairBusy] = useState(false);
  useEffect(() => {
    const AppPlugin = window.Capacitor?.Plugins?.App;
    if (!AppPlugin?.addListener) return;
    let sub;
    try {
      sub = AppPlugin.addListener('appUrlOpen', ({ url }) => {
        const req = parseSetupLink(url);
        if (req) setPairReq(req);
        else toast('无法识别的配对链接', 'error');
      });
    } catch { return; }
    return () => { Promise.resolve(sub).then((h) => h?.remove?.()).catch(() => { /* noop */ }); };
  }, []);
  const confirmPair = useCallback(async () => {
    if (!pairReq || pairBusy) return;
    setPairBusy(true);
    const ok = await tryConnectBases(pairReq.bases, pairReq.token);
    setPairBusy(false);
    if (ok) { setPairReq(null); toast(`已连接 ${connHost()}`, 'info'); }
  }, [pairReq, pairBusy, tryConnectBases]);

  useEffect(() => {
    if (!token) return;
    const bases = loadBases();
    if (bases.length > 0) tryConnectBases(bases, token);
    else tryConnect(baseUrl, token);
  }, []);

  const pairOverlay = pairReq && html`
    <${PairConfirm} req=${pairReq} busy=${pairBusy} hasExisting=${!!(token || baseUrl)}
      onConfirm=${confirmPair} onCancel=${() => setPairReq(null)} />`;

  if (route.view === 'pair') {
    return html`
      <${PairPage} goList=${goList} />
      ${pairOverlay}
      <${ToastLayer} />`;
  }
  if (auth !== 'ok') {
    return html`
      <${SetupGate} busy=${auth === 'checking'} error=${authErr} onSubmit=${tryConnect} />
      ${pairOverlay}
      <${ToastLayer} />`;
  }
  return html`
    <${ConnBar} />
    <div class="shell" data-route=${route.view}>
      <${Sidebar} route=${route} goList=${goList} goSettings=${goSettings} goChat=${goChat} />
      <main class="main">
        ${route.view === 'chat' ? html`<${Chat} key=${route.sessionId} sessionId=${route.sessionId} goList=${goList} />`
        : route.view === 'settings' ? html`<${SettingsPage} onReconnect=${tryConnect} goList=${goList} />`
        : html`<${StartScreen} goChat=${goChat} goSettings=${goSettings} />`}
      </main>
    </div>
    <${ApprovalLayer} />
    ${pairOverlay}
    <${ToastLayer} />`;
}

render(html`<${App} />`, document.getElementById('app'));
