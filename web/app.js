// app.js — Claude Remote Web UI（Claude App 风格重构版）
// 原生 ES modules，免构建。唯一后端知识来源：docs/api-contract.md。
// 相比 05 卡初版的三点扩展：① 服务器地址可配置（iOS 壳/非同源部署）；
// ② 设置页；③ 附件上传（POST /api/sessions/:id/upload）。
import {
  html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
} from './vendor/preact-htm-standalone.module.js';
import { marked } from './vendor/marked.esm.min.js';

// ================================================================ 工具

const STATUS_LABEL = { idle: '可接管', 'terminal-driving': '终端驾驶', 'daemon-driving': '运行中' };
const STATUS_DOT = { idle: 'dot-idle', 'terminal-driving': 'dot-term', 'daemon-driving': 'dot-run' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function relTime(ts, nowMs = Date.now()) {
  const d = nowMs - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} 天前`;
  const t = new Date(ts);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}
function fmtClock(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
function cwdTail(cwd, segs = 2) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-segs).join('/');
}
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function toolSummary(m) {
  const i = m.toolInput || {};
  return truncate(i.command || i.file_path || i.pattern || i.url || i.description || i.prompt || JSON.stringify(i), 90);
}
const msgKey = (m) => `${m.seq}:${m.blockIndex ?? 0}`;
// 与 addMsgs 的 sort 比较函数保持一致：seq 主键，blockIndex 次键。
const cmpMsg = (a, b) => (a.seq - b.seq) || ((a.blockIndex ?? 0) - (b.blockIndex ?? 0));

// Claude 星芒 logo（12 条圆头光芒，品牌橙）
const Spark = ({ cls = '' }) => html`
  <svg class="spark ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
    <line x1="12" y1="12" x2="12.12" y2="2.61" stroke-width="2.1"/>
    <line x1="12" y1="12" x2="15.74" y2="4.05" stroke-width="1.87"/>
    <line x1="12" y1="12" x2="19.08" y2="5.26" stroke-width="2.11"/>
    <line x1="12" y1="12" x2="20.5" y2="9.21" stroke-width="2.12"/>
    <line x1="12" y1="12" x2="20.99" y2="13.22" stroke-width="1.64"/>
    <line x1="12" y1="12" x2="20.58" y2="16.96" stroke-width="1.93"/>
    <line x1="12" y1="12" x2="18" y2="19.28" stroke-width="2.09"/>
    <line x1="12" y1="12" x2="14.53" y2="21.37" stroke-width="1.52"/>
    <line x1="12" y1="12" x2="10.46" y2="20.4" stroke-width="1.63"/>
    <line x1="12" y1="12" x2="6.11" y2="19.54" stroke-width="1.52"/>
    <line x1="12" y1="12" x2="3.33" y2="17.48" stroke-width="1.84"/>
    <line x1="12" y1="12" x2="2.92" y2="12.61" stroke-width="1.81"/>
    <line x1="12" y1="12" x2="3.77" y2="9.83" stroke-width="1.89"/>
    <line x1="12" y1="12" x2="5.43" y2="5.94" stroke-width="1.95"/>
    <line x1="12" y1="12" x2="8.02" y2="3.85" stroke-width="2.02"/>
  </svg>`;

// ================================================================ 事件总线

const bus = {
  m: new Map(),
  on(type, fn) {
    if (!this.m.has(type)) this.m.set(type, new Set());
    this.m.get(type).add(fn);
    return () => this.m.get(type)?.delete(fn);
  },
  emit(type, data) { this.m.get(type)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};
function useBus(type, fn, deps) { useEffect(() => bus.on(type, fn), deps); }

function toast(text, kind = 'info') { bus.emit('toast', { id: Math.random().toString(36).slice(2), text, kind }); }

// ================================================================ 连接配置 + HTTP 客户端
// baseUrl 为空 = 同源部署（daemon 直接托管 web/）；iOS 壳/本地文件打开时必填。

const TOKEN_KEY = 'bridge_token';
const BASE_KEY = 'bridge_base';
const BASES_KEY = 'bridge_bases'; // 候选地址表（JSON 数组，扫码配对写入，连接时顺序探测）
let token = localStorage.getItem(TOKEN_KEY) || '';
let baseUrl = (localStorage.getItem(BASE_KEY) || '').trim().replace(/\/+$/, '');

function loadBases() {
  try {
    const arr = JSON.parse(localStorage.getItem(BASES_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}
function saveBases(bases) { localStorage.setItem(BASES_KEY, JSON.stringify(bases)); }

function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}
function saveConn(base, tok) {
  baseUrl = normalizeBase(base);
  token = tok;
  localStorage.setItem(BASE_KEY, baseUrl);
  localStorage.setItem(TOKEN_KEY, token);
}
function connHost() {
  if (baseUrl) { try { return new URL(baseUrl).host; } catch { return baseUrl; } }
  return location.host;
}
function wsEndpoint() {
  let host = location.host;
  let secure = location.protocol === 'https:';
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      host = u.host;
      secure = u.protocol === 'https:';
    } catch { /* 保底同源 */ }
  }
  return `${secure ? 'wss' : 'ws'}://${host}/ws?token=${encodeURIComponent(token)}`;
}

class ApiError extends Error {
  constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data || {}; }
}
// 各类请求的超时：健康检查 8s、普通 20s、上传 60s（黑洞地址不再无限挂起）
function apiTimeoutMs(path) {
  if (path.startsWith('/api/health')) return 8_000;
  if (path.includes('/upload')) return 60_000;
  return 20_000;
}
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? apiTimeoutMs(path));
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    throw new ApiError(0, ctrl.signal.aborted ? 'network_timeout' : 'network_error');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { bus.emit('unauthorized'); throw new ApiError(401, 'unauthorized'); }
  if (!res.ok) throw new ApiError(res.status, data.error || `http_${res.status}`, data);
  return data;
}

// ---- 多候选地址探测：逐个 GET /api/health（各带 8s 超时），返回首个成功的 base。
// token 错误立即抛出（换地址也救不了）；否则记住最后一次网络错误。
async function probeBase(base, tok) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${tok}` }, signal: ctrl.signal });
    if (res.status === 401) throw new ApiError(401, 'unauthorized');
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, ctrl.signal.aborted ? 'network_timeout' : 'network_error');
  } finally { clearTimeout(timer); }
}
async function probeBases(bases, tok) {
  let lastErr = new ApiError(0, 'network_error');
  for (const raw of bases) {
    const base = normalizeBase(raw);
    if (!base) continue;
    try { await probeBase(base, tok); return base; }
    catch (e) { if (e.code === 'unauthorized') throw e; lastErr = e; }
  }
  throw lastErr;
}
function connErrMsg(e) {
  if (e.code === 'unauthorized') return 'token 不正确';
  if (e.code === 'network_timeout') return '连接超时（Mac 不可达）：检查 Mac 上 daemon 是否在跑、Tailscale 是否开启';
  return '无法连接 daemon（地址或网络错误）';
}

// 会话元信息缓存（标题/状态，聊天页与审批卡共用）
const sessionCache = new Map();
const pendingSessionMessages = new Map();
let modelCache = { models: [], defaultModel: '' };
function cacheSessions(list) { for (const s of list) sessionCache.set(s.sessionId, s); }
async function fetchSessions(limit = 100) {
  const d = await api(`/api/sessions?limit=${limit}`);
  cacheSessions(d.sessions);
  bus.emit('sessions-cached');
  return d;
}
async function fetchModels() {
  const d = await api('/api/models');
  modelCache = {
    models: Array.isArray(d.models) ? d.models : [],
    defaultModel: typeof d.defaultModel === 'string' ? d.defaultModel : '',
  };
  bus.emit('models-cached', modelCache);
  return modelCache;
}
function modelValue(model) { return model.alias || model.id || ''; }
function modelLabel(model) { return model.displayName || model.alias || model.id || '未命名模型'; }
// 真实映射名（Mac settings.json 里的实际模型 id）为主，别名为辅。
function modelMainName(model) { return model.id || model.alias || '未命名模型'; }
function findModel(models, value) {
  if (!value) return null;
  return models.find((m) => m.alias === value || m.id === value) || null;
}
// 把默认别名（如 "fable"）解析为真实映射名（如 "claude-fable-5[1M]"）
function resolveDefaultName(catalog) {
  const { models = [], defaultModel = '' } = catalog || {};
  if (!defaultModel) return '';
  const m = findModel(models, defaultModel);
  return m ? modelMainName(m) : defaultModel;
}

// ================================================================ WebSocket 连接层
// 指数退避重连；重连成功后重发全部 subscribe，并广播 ws-open 让视图补缺口。

const ws = (() => {
  let sock = null;
  let attempt = 0;
  let timer = null;
  let stopped = true;
  const subs = new Set(['*']);
  const state = { phase: 'closed', retryAt: 0 }; // connecting | open | closed

  function emitState(phase) { state.phase = phase; bus.emit('ws-state', { ...state }); }
  function send(obj) { if (sock?.readyState === 1) sock.send(JSON.stringify(obj)); }
  function scheduleRetry() {
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 400;
    state.retryAt = Date.now() + delay;
    emitState('closed');
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
  }
  function connect() {
    if (stopped) return;
    emitState('connecting');
    let s;
    try { s = new WebSocket(wsEndpoint()); } catch { scheduleRetry(); return; }
    sock = s;
    const stale = () => sock !== s; // 被替换/废弃的 socket 不得再驱动状态机
    // CONNECTING 悬挂守卫：6s 未完成握手就放弃，走 onclose 重试
    const connGuard = setTimeout(() => { if (!stale() && s.readyState === 0) { try { s.close(); } catch { /* noop */ } } }, 6000);
    s.onopen = () => {
      if (stale()) { try { s.close(); } catch { /* noop */ } return; }
      clearTimeout(connGuard);
      attempt = 0;
      emitState('open');
      for (const id of subs) send({ type: 'subscribe', sessionId: id });
      bus.emit('ws-open');
    };
    s.onmessage = (e) => {
      if (stale()) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m?.type) bus.emit(`ws:${m.type}`, m);
    };
    s.onerror = () => { if (!stale()) { try { s.close(); } catch { /* noop */ } } };
    s.onclose = () => {
      clearTimeout(connGuard);
      if (stale() || stopped) return;
      scheduleRetry();
    };
  }
  return {
    state,
    start() { if (!stopped) return; stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      const s = sock;
      sock = null; // 先置空让事件守卫失效，再关闭
      try { s?.close(); } catch { /* noop */ }
      emitState('closed');
    },
    reconnectNow() {
      if (stopped) return;
      clearTimeout(timer);
      attempt = 0;
      const s = sock;
      sock = null;
      try { s?.close(); } catch { /* noop */ }
      connect();
    },
    subscribe(id) { subs.add(id); send({ type: 'subscribe', sessionId: id }); },
    unsubscribe(id) { subs.delete(id); send({ type: 'unsubscribe', sessionId: id }); },
  };
})();

// ================================================================ Markdown

marked.use({
  gfm: true,
  breaks: true,
  // 原始 HTML 一律转义成文本（transcript 内容不可信，vendor 三件套之外不引 sanitizer）
  renderer: {
    html(tok) { return escapeHtml(typeof tok === 'string' ? tok : (tok?.text ?? tok?.raw ?? '')); },
  },
});

function Markdown({ text }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    try { el.innerHTML = marked.parse(text || ''); } catch { el.textContent = text || ''; }
    for (const a of el.querySelectorAll('a')) {
      if (/^\s*javascript:/i.test(a.getAttribute('href') || '')) a.setAttribute('href', '#');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }, [text]);
  return html`<div class="md" ref=${ref}></div>`;
}

// ================================================================ 路由（hash）

function parseHash() {
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
// 手机抽屉侧栏开合（桌面固定列不受影响）
const openDrawer = () => bus.emit('drawer', true);
const closeDrawer = () => bus.emit('drawer', false);

// ================================================================ 小组件

function StatusBadge({ status }) {
  if (!status) return null;
  return html`<span class="badge ${STATUS_DOT[status] || ''}"><i class="dot"></i>${STATUS_LABEL[status] || status}</span>`;
}

function ConnBar() {
  const [st, setSt] = useState({ ...ws.state });
  const [, setTick] = useState(0);
  useBus('ws-state', (s) => setSt(s), []);
  // 补拍：初始快照与订阅生效之间有空窗（本地握手仅几 ms，open 可能落在其间被漏），订阅后同步一次
  useEffect(() => { setSt({ ...ws.state }); }, []);
  useEffect(() => {
    if (st.phase !== 'closed') return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [st.phase]);
  if (st.phase === 'open') return null;
  if (st.phase === 'connecting') return html`<div class="connbar connecting">连接中…</div>`;
  const secs = Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000));
  return html`<div class="connbar closed" onClick=${() => ws.reconnectNow()}>连接已断开，${secs}s 后重连 · 点击立即重试</div>`;
}

function ToastLayer() {
  const [items, setItems] = useState([]);
  useBus('toast', (t) => {
    setItems((xs) => [...xs, t]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
  }, []);
  return html`<div class="toasts">${items.map((t) => html`<div key=${t.id} class="toast ${t.kind}">${t.text}</div>`)}</div>`;
}

function useModelCatalog() {
  const [catalog, setCatalog] = useState(modelCache);
  const load = useCallback(async () => {
    try { setCatalog(await fetchModels()); } catch { /* The composer remains usable with the Mac default. */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useBus('ws-open', load, [load]);
  useBus('models-cached', setCatalog, []);
  return catalog;
}

// 自定义模型弹层（图4 风格）：主行=真实映射名(id)，副行=别名，选中打勾。
// 取值语义不变：onChange 回传 alias||id 或 ''（空=跟随 Mac 默认）。
function ModelPicker({ catalog, value, onChange, compact = false }) {
  const { models, defaultModel } = catalog || modelCache;
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const sel = findModel(models, value);
  const defName = resolveDefaultName(catalog);
  const triggerMain = sel ? modelMainName(sel) : `跟随 Mac 默认${defName ? `（${defName}）` : ''}`;
  const pick = (v) => { onChange(v); setOpen(false); };

  return html`
    <div class="model-picker ${compact ? 'compact' : ''}" ref=${rootRef}>
      <span class="select-label">模型</span>
      <button type="button" class="model-trigger" aria-haspopup="listbox" aria-expanded=${open}
        onClick=${() => setOpen((x) => !x)}>
        <span class="model-trigger-name">${triggerMain}</span>
        <span class="model-caret">⌄</span>
      </button>
      ${open && html`
        <div class="model-menu-backdrop" onClick=${() => setOpen(false)}></div>
        <div class="model-menu" role="listbox">
          <button type="button" class="model-opt ${!value ? 'on' : ''}" role="option" aria-selected=${!value} onClick=${() => pick('')}>
            <span class="model-opt-text">
              <span class="model-opt-main">跟随 Mac 默认</span>
              <span class="model-opt-sub">${defName ? `当前 ${defName}` : '使用 Mac settings.json 的默认模型'}</span>
            </span>
            ${!value && html`<span class="model-check">✓</span>`}
          </button>
          ${models.map((m) => {
            const v = modelValue(m);
            const on = sel && (sel.alias === m.alias && sel.id === m.id);
            return html`
              <button type="button" key=${v} class="model-opt ${on ? 'on' : ''}" role="option" aria-selected=${on} onClick=${() => pick(v)}>
                <span class="model-opt-text">
                  <span class="model-opt-main">${modelMainName(m)}</span>
                  ${m.alias && m.alias !== m.id && html`<span class="model-opt-sub">别名 ${m.alias}</span>`}
                </span>
                ${on && html`<span class="model-check">✓</span>`}
              </button>`;
          })}
        </div>`}
    </div>`;
}

function ProjectPicker({ projects, value, onChange, compact = false }) {
  return html`
    <label class="select-control ${compact ? 'compact' : ''}">
      <span class="select-label">项目</span>
      <select value=${value || ''} onChange=${(e) => onChange(e.target.value)} aria-label="选择项目" disabled=${projects.length === 0}>
        ${projects.length === 0
          ? html`<option value="">暂无已知项目</option>`
          : projects.map((cwd) => html`<option key=${cwd} value=${cwd}>${cwdTail(cwd, 3)}</option>`)}
      </select>
    </label>`;
}

// ================================================================ 连接表单（首次设置 + 设置页共用）

function ConnForm({ initBase, initToken, busy, submitLabel, onSubmit }) {
  const [base, setBase] = useState(initBase);
  const [tok, setTok] = useState(initToken);
  return html`
    <form class="conn-form" onSubmit=${(e) => { e.preventDefault(); if (tok.trim()) onSubmit(base.trim(), tok.trim()); }}>
      <label class="field">
        <span class="field-label">Mac 服务器地址</span>
        <input type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false"
          placeholder="如 http://100.64.0.5:8787（留空 = 当前地址）"
          value=${base} onInput=${(e) => setBase(e.target.value)} />
        <span class="field-hint">填 Mac 的 Tailscale IP 或局域网 IP + daemon 端口</span>
      </label>
      <label class="field">
        <span class="field-label">访问令牌（BRIDGE_TOKEN）</span>
        <input type="password" autocomplete="off" placeholder="daemon .env 里的 BRIDGE_TOKEN"
          value=${tok} onInput=${(e) => setTok(e.target.value)} />
        <span class="field-hint">与 Mac 上 daemon 配置的 token 一致</span>
      </label>
      <button class="btn primary wide" type="submit" disabled=${busy || !tok.trim()}>
        ${busy ? '连接中…' : submitLabel}
      </button>
    </form>`;
}

function SetupGate({ error, busy, onSubmit }) {
  return html`
    <div class="gate">
      <div class="gate-card">
        <${Spark} cls="gate-logo" />
        <h1 class="serif">Claude Remote</h1>
        <p class="gate-sub">连接你 Mac 上的 Claude Code</p>
        <${ConnForm} initBase=${baseUrl} initToken="" busy=${busy} submitLabel="连接" onSubmit=${onSubmit} />
        ${error && html`<p class="err">${error}</p>`}
        <p class="gate-help">Mac 端打开配对页，用相机扫码即可</p>
        <p class="gate-help">Mac 端：<code>cd claude-remote && pnpm dev</code> 启动 daemon，手机与 Mac 同一 Tailscale 网络</p>
      </div>
    </div>`;
}

// ================================================================ 设置页

function SettingsPage({ onReconnect }) {
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/health').then(setHealth).catch(() => setHealth(null)); }, []);

  const submit = async (base, tok) => {
    setBusy(true);
    const ok = await onReconnect(base, tok);
    setBusy(false);
    if (ok) { toast('已保存并重新连接', 'info'); goList(); }
  };

  return html`
    <div class="page settings-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-title serif">设置</div>
      </header>
      <div class="scroll">
        <div class="settings-body">
          <section class="settings-card">
            <h2>连接</h2>
            <${ConnForm} initBase=${baseUrl} initToken=${token} busy=${busy} submitLabel="保存并重新连接" onSubmit=${submit} />
          </section>
          <section class="settings-card">
            <h2>状态</h2>
            <dl class="kv">
              <div><dt>服务器</dt><dd class="mono">${connHost()}</dd></div>
              <div><dt>daemon</dt><dd>${health ? `v${health.version}` : '未连接'}</dd></div>
              <div><dt>Claude CLI</dt><dd>${health?.claudeCliVersion || '—'}</dd></div>
            </dl>
          </section>
          <section class="settings-card">
            <h2>快速上手</h2>
            <ol class="howto">
              <li>在 Mac 上安装并启动 daemon：<code>pnpm dev</code>（首次先在 <code>.env</code> 里设置 <code>BRIDGE_TOKEN</code>）</li>
              <li>Mac 与手机安装 <b>Tailscale</b> 并登录同一账号</li>
              <li>把 <code>.env</code> 的 <code>BRIDGE_HOST</code> 改为 Mac 的 Tailscale IP 并重启 daemon</li>
              <li>在上方填入 <code>http://«Tailscale IP»:8787</code> 与 token，保存即可</li>
            </ol>
          </section>
          <button class="btn ghost wide danger" onClick=${() => bus.emit('logout')}>断开并清除本机凭据</button>
        </div>
      </div>
    </div>`;
}

// ================================================================ 配对页（#/pair，Mac 本机浏览器打开）

function PairPage() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [showTok, setShowTok] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    // pair-info 仅限 loopback，无需 Bearer；403/超时/网络错误统一按「非本机打开」提示
    fetch(`${baseUrl}/api/pair-info`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`http_${res.status}`))))
      .then((d) => setInfo({ bases: Array.isArray(d.bases) ? d.bases : [], token: d.token || '' }))
      .catch(() => setFailed(true))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  return html`
    <div class="page pair-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-title serif">扫码配对</div>
      </header>
      <div class="scroll">
        <div class="pair-body">
          ${failed && html`
            <section class="settings-card">
              <p class="err">配对信息不可用：此页仅限 Mac 本机打开（<code>http://127.0.0.1:8788/#/pair</code>）。</p>
            </section>`}
          ${!failed && html`
            <section class="settings-card pair-qr-card">
              <img class="pair-qr" src="${baseUrl}/api/pair-qr.svg" alt="配对二维码" />
              <p class="pair-hint">用 iPhone 相机扫码，点「在 Claude Remote 中打开」即可自动配对</p>
            </section>
            <section class="settings-card">
              <h2>候选地址</h2>
              ${info
                ? html`<ul class="pair-bases">${info.bases.map((b) => html`<li key=${b} class="mono">${b}</li>`)}</ul>`
                : html`<div class="empty">加载中…</div>`}
            </section>
            <section class="settings-card">
              <h2>访问令牌</h2>
              <div class="pair-token-row">
                <span class="mono ellip">${info ? (showTok ? info.token : '••••••••••••') : '…'}</span>
                <button class="btn" type="button" disabled=${!info} onClick=${() => setShowTok((x) => !x)}>${showTok ? '隐藏' : '显示'}</button>
              </div>
              <p class="pair-hint">二维码即凭据，请勿截图外传；此页仅限 Mac 本机打开。</p>
            </section>`}
        </div>
      </div>
    </div>`;
}

// ================================================================ 侧栏（会话列表 + 导航）

function Sidebar({ route }) {
  const [data, setData] = useState({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [, setTick] = useState(0); // 相对时间刷新

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

  // 手机抽屉开合（桌面 ≥900px 由 CSS 固定显示，drawerOpen 无副作用）
  const [drawerOpen, setDrawerOpen] = useState(false);
  useBus('drawer', setDrawerOpen, []);
  useEffect(() => { setDrawerOpen(false); }, [route.view, route.sessionId]); // 路由变化关抽屉
  const nav = (fn) => () => { fn(); setDrawerOpen(false); };

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
      </div>
      <div class="side-foot">
        <span class="conn-dot ${wsPhase}"></span>
        <span class="ellip mono">${connHost()}</span>
      </div>
    </aside>`;
}

// ================================================================ 新对话首页

function NewChatComposer({ projects, catalog, onCreated }) {
  const [draft, setDraft] = useState('');
  const [cwd, setCwd] = useState(projects[0] || '');
  const [model, setModel] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!cwd || !projects.includes(cwd)) setCwd(projects[0] || '');
  }, [projects, cwd]);

  const removeFile = (idx) => setFiles((xs) => xs.filter((_, i) => i !== idx));
  const create = useCallback(async () => {
    let text = draft.trim();
    if (!text || !cwd || busy) return;
    setBusy(true);
    try {
      // 先传附件（会话还不存在，走全局 /api/upload），路径随首条消息一起发，避免 Claude 先答后收图
      if (files.length) {
        const uploaded = [];
        for (const f of files) {
          const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
            method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
          });
          uploaded.push(r.path);
        }
        text = `${text}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${uploaded.map((p) => `- ${p}`).join('\n')}`;
      }
      const body = { cwd, text, ...(model ? { model } : {}) };
      const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
      onCreated(result, body);
      setDraft('');
      setFiles([]);
    } catch (e) {
      if (e.status === 409) toast('所选项目当前不可创建新会话', 'error');
      else if (e.status === 413) toast('附件过大（上限 25MB）', 'error');
      else if (e.code === 'unknown_model') toast('该模型已不可用，请重新选择', 'error');
      else if (e.code === 'unknown_cwd') toast('该项目已不可用，请刷新后重试', 'error');
      else if (e.code !== 'unauthorized') toast(`新建失败：${e.code}`, 'error');
    } finally { setBusy(false); }
  }, [draft, cwd, model, busy, files, onCreated]);

  const onInput = (e) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  };

  return html`
    <div class="new-composer">
      <div class="composer-card ${busy ? 'disabled' : ''}">
        ${files.length > 0 && html`
          <div class="attach-chips">
            ${files.map((f, i) => html`
              <span class="chip" key=${`${f.name}:${i}`}>
                <span class="chip-name">${truncate(f.name, 24)}</span>
                <span class="chip-size">${fmtBytes(f.size)}</span>
                <button class="chip-x" onClick=${() => removeFile(i)} aria-label="移除附件">✕</button>
              </span>`)}
          </div>`}
        <textarea ref=${taRef} rows="2" placeholder="今天想做什么？" value=${draft} disabled=${busy}
          onInput=${onInput}
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); } }}></textarea>
        <div class="new-composer-options">
          <${ProjectPicker} projects=${projects} value=${cwd} onChange=${setCwd} compact=${true} />
          <${ModelPicker} catalog=${catalog} value=${model} onChange=${setModel} compact=${true} />
        </div>
        <div class="composer-tools">
          <input ref=${fileRef} type="file" multiple hidden
            onChange=${(e) => { setFiles((xs) => [...xs, ...(e.target.files || [])]); e.target.value = ''; }} />
          <button class="tool-btn" title="选择附件" aria-label="选择附件" disabled=${busy} onClick=${() => fileRef.current?.click()}>+</button>
          <span class="flex1"></span>
          <button class="send-btn" disabled=${busy || !draft.trim() || !cwd} onClick=${create} aria-label="创建会话并发送">
            ${busy ? html`<span class="spin">⟳</span>` : '↑'}
          </button>
        </div>
      </div>
      ${files.length > 0 && html`<div class="new-attach-note">附件将随首条消息一起发送。</div>`}
    </div>`;
}

function StartScreen() {
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const catalog = useModelCatalog();
  const [data, setData] = useState({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setData(await fetchSessions(500)); setError(''); }
    catch (e) { if (e.code !== 'unauthorized') setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useBus('ws-open', () => load(true), [load]);
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
  }, []);

  return html`
    <div class="page home-page">
      <header class="home-topbar">
        <button class="icon-btn menu-btn" onClick=${openDrawer} aria-label="打开侧栏" title="最近对话">☰</button>
        <div class="brand serif"><${Spark} cls="brand-spark" />Claude Remote</div>
        <button class="icon-btn" onClick=${goSettings} aria-label="设置" title="设置">⚙</button>
      </header>
      <div class="scroll home-scroll">
        <section class="home-new home-new-centered">
          <div class="home-heading">
            <${Spark} cls="welcome-spark" />
            <h1 class="serif">${greet}，一起做点什么？</h1>
          </div>
          <${NewChatComposer} projects=${projects} catalog=${catalog} onCreated=${created} />
          ${error && html`<div class="page-err home-err" onClick=${() => load()}>${error} · 点击重试</div>`}
        </section>
      </div>
    </div>`;
}

// ================================================================ 消息渲染

function MessageRow({ m }) {
  if (m.kind === 'meta') {
    return html`<div class="msg-meta">· ${m.rawType || 'meta'} ·</div>`;
  }
  if (m.kind === 'thinking') {
    return html`
      <details class="block thinking">
        <summary><${Spark} cls="blk-spark" />思考过程</summary>
        <div class="blk-body pre">${m.text}</div>
      </details>`;
  }
  if (m.kind === 'tool_use') {
    return html`
      <details class="block tool-use">
        <summary><span class="blk-ico">⚒</span><b>${m.toolName}</b><span class="blk-sub mono">${toolSummary(m)}</span></summary>
        <div class="blk-body"><pre class="mono">${JSON.stringify(m.toolInput ?? {}, null, 2)}</pre></div>
      </details>`;
  }
  if (m.kind === 'tool_result') {
    const chars = (m.text || '').length;
    return html`
      <details class="block tool-result ${m.isError ? 'is-err' : ''}">
        <summary><span class="blk-ico">${m.isError ? '✕' : '✓'}</span>${m.isError ? '工具出错' : '工具结果'}<span class="blk-sub">${chars} 字符</span></summary>
        <div class="blk-body pre mono">${m.text}</div>
      </details>`;
  }
  // kind === text
  if (m.role === 'user') {
    return html`
      <div class="msg user">
        <span class="avatar user-avatar">我</span>
        <div class="bubble">${m.text}</div>
        <div class="msg-time">${fmtClock(m.timestamp)}</div>
      </div>`;
  }
  return html`
    <div class="msg assistant">
      <span class="avatar ai-avatar"><${Spark} /></span>
      <div class="msg-body">
        <${Markdown} text=${m.text} />
        <div class="msg-time">${fmtClock(m.timestamp)}</div>
      </div>
    </div>`;
}

// ================================================================ 聊天页

function Chat({ sessionId }) {
  const catalog = useModelCatalog();
  const store = useRef({ map: new Map(), sorted: [] });
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(sessionCache.get(sessionId) || null);
  const [status, setStatus] = useState(sessionCache.get(sessionId)?.status || null);
  const [hasMore, setHasMore] = useState(false);
  const [firstSeq, setFirstSeq] = useState(null);
  const [initLoading, setInitLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [runActive, setRunActive] = useState(() => sessionCache.get(sessionId)?.status === 'daemon-driving');
  const [pending, setPending] = useState(null); // 已 POST、尚未从 WS 回显的用户消息
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]); // 待上传附件 File[]
  const [sendBusy, setSendBusy] = useState(false);
  const [modelOverride, setModelOverride] = useState('');
  const [activeRunId, setActiveRunId] = useState(null);
  const [showJump, setShowJump] = useState(false);

  const scrollRef = useRef(null);
  const stick = useRef(true);
  const prependRef = useRef(null);
  const loadingOlder = useRef(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  const addMsgs = useCallback((list) => {
    const st = store.current;
    const fresh = [];
    for (const m of list) {
      const k = msgKey(m);
      if (!st.map.has(k)) { st.map.set(k, m); fresh.push(m); }
    }
    if (fresh.length === 0) return false;
    fresh.sort(cmpMsg);
    const sorted = st.sorted;
    // 快路径：fresh 内部已排序，若整体 ≥ 当前尾部则直接追加，跳过全量 sort。
    const canAppend = sorted.length === 0 || cmpMsg(sorted[sorted.length - 1], fresh[0]) <= 0;
    st.sorted = canAppend ? sorted.concat(fresh) : [...st.map.values()].sort(cmpMsg);
    setVersion((v) => v + 1);
    return true;
  }, []);

  // ---- 初始加载：尾部 100 条 + 会话元信息
  useEffect(() => {
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    setInitLoading(true);
    setLoadErr('');
    stick.current = true;
    const initialText = pendingSessionMessages.get(sessionId);
    if (initialText) {
      setPending(initialText);
      pendingSessionMessages.delete(sessionId);
    }
    ws.subscribe(sessionId);
    (async () => {
      try {
        let d;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
            break;
          } catch (error) {
            if (error.code !== 'session_not_found' || attempt === 7) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        addMsgs(d.messages);
        setFirstSeq(d.firstSeq);
        setHasMore(d.hasMore);
      } catch (e) {
        setLoadErr(e.code === 'session_not_found' ? '会话不存在' : `加载失败：${e.code}`);
      } finally { setInitLoading(false); }
      if (!sessionCache.has(sessionId)) { try { await fetchSessions(200); } catch { /* 列表拿不到就用兜底展示 */ } }
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus((st) => st ?? s.status); }
    })();
    return () => ws.unsubscribe(sessionId);
  }, [sessionId, addMsgs]);

  // ---- WS 事件
  const pendingBatch = useRef(null); // 同 tick 内多条 ws:message 合并成一次 addMsgs
  useBus('ws:message', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = e.message;
    if (m.role === 'user' && m.kind === 'text') {
      setPending((p) => (p && m.text?.trim() === p.trim() ? null : p));
    }
    if (!pendingBatch.current) {
      pendingBatch.current = [];
      queueMicrotask(() => {
        const batch = pendingBatch.current;
        pendingBatch.current = null;
        if (batch && batch.length) addMsgs(batch);
      });
    }
    pendingBatch.current.push(m);
  }, [sessionId, addMsgs]);
  useBus('ws:status', (e) => { if (e.sessionId === sessionId) setStatus(e.status); }, [sessionId]);
  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') { setRunActive(true); setActiveRunId(e.runId || null); }
    else {
      setRunActive(false);
      setActiveRunId(null);
      setPending(null);
      if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
    }
  }, [sessionId]);

  // ---- resync：daemon 侧链视图失效（终端 rewind/fork 或文件截断），清空本地列表全量重拉
  useBus('ws:resync', async (e) => {
    if (e.sessionId !== sessionId) return;
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      addMsgs(d.messages);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
    } catch { /* 拉取失败：等下次 ws-open 补缺口或用户翻页 */ }
  }, [sessionId, addMsgs]);

  // ---- 重连补缺口：拉尾部，若与已有消息无重叠则继续向前翻，直到接上（最多 3 页）
  useBus('ws-open', async () => {
    const st = store.current;
    if (st.map.size === 0) return;
    try {
      let d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      let overlap = d.messages.some((m) => st.map.has(msgKey(m)));
      const pages = [d.messages];
      let guard = 0;
      let cursor = d.firstSeq;
      while (!overlap && d.hasMore && guard++ < 3) {
        d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${cursor}`);
        overlap = d.messages.some((m) => st.map.has(msgKey(m)));
        pages.push(d.messages);
        cursor = d.firstSeq;
      }
      addMsgs(pages.flat());
    } catch { /* 断线补拉失败，等下次重连 */ }
    // 断线期间可能错过 status 事件，顺带刷新会话状态
    try {
      await fetchSessions(200);
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus(s.status); }
    } catch { /* 状态刷新失败不阻塞 */ }
  }, [sessionId, addMsgs]);

  // ---- 向上翻页
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    loadingOlder.current = true;
    const el = scrollRef.current;
    prependRef.current = { h: el.scrollHeight, top: el.scrollTop };
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
      if (!addMsgs(d.messages)) prependRef.current = null;
    } catch (e) {
      prependRef.current = null;
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, addMsgs]);

  // ---- 滚动维护
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependRef.current) {
      el.scrollTop = el.scrollHeight - prependRef.current.h + prependRef.current.top;
      prependRef.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [version, runActive, pending, initLoading]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stick.current = nearBottom;
    setShowJump(!nearBottom);
    if (el.scrollTop < 60) loadOlder();
  }, [loadOlder]);

  // ---- 键盘弹出时保持贴底
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const h = () => { if (stick.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
    vv.addEventListener('resize', h);
    return () => vv.removeEventListener('resize', h);
  }, []);

  // ---- 附件
  const onPickFiles = (e) => {
    const picked = [...(e.target.files || [])];
    if (picked.length) setFiles((xs) => [...xs, ...picked]);
    e.target.value = '';
  };
  const removeFile = (i) => setFiles((xs) => xs.filter((_, idx) => idx !== i));

  // ---- 发送
  const isRunning = runActive || status === 'daemon-driving';
  const canSend = status === 'idle' && !sendBusy;
  const hasContent = draft.trim() !== '' || files.length > 0;
  const disabledReason = sendBusy ? '发送中…'
    : status === 'terminal-driving' ? '终端驾驶中，暂不可发送'
    : status === 'daemon-driving' ? 'Claude 正在运行…'
    : status == null ? '状态获取中…' : '';

  const stopRun = useCallback(async () => {
    if (!isRunning) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: JSON.stringify({ runId: activeRunId || undefined }) });
      setRunActive(false);
      setActiveRunId(null);
      setStatus('idle');
      toast('已停止当前运行', 'info');
    } catch (e) {
      if (e.status === 404 || e.status === 409 || e.code === 'no_active_run' || e.code === 'already_finished') {
        setRunActive(false);
        setActiveRunId(null);
        setStatus('idle');
        toast('运行已结束', 'info');
      } else if (e.code !== 'unauthorized') toast(`停止失败：${e.code}`, 'error');
    }
  }, [sessionId, activeRunId, isRunning]);

  const doSend = useCallback(async () => {
    if (!hasContent || !canSend) return;
    setSendBusy(true);
    try {
      // 先传附件（存到 Mac 本地），再把路径写进消息文本让 Claude 直接读
      const uploaded = [];
      for (const f of files) {
        const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
        });
        uploaded.push(r.path);
      }
      let text = draft.trim();
      if (uploaded.length) {
        const list = uploaded.map((p) => `- ${p}`).join('\n');
        text = `${text || '请查看我上传的附件。'}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${list}`;
      }
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST', body: JSON.stringify({ text, ...(modelOverride ? { model: modelOverride } : {}) }),
      });
      setPending(text);
      setDraft('');
      setFiles([]);
      if (taRef.current) taRef.current.style.height = 'auto';
      stick.current = true;
    } catch (e) {
      if (e.status === 409) {
        setStatus(e.data.status || null);
        const why = e.data.status === 'terminal-driving' ? '会话正被终端驾驶' : e.data.status === 'daemon-driving' ? 'Claude 正在运行' : '会话被占用';
        toast(`${why}，发送被拒`, 'error');
      } else if (e.status === 413) {
        toast('附件过大（上限 25MB）', 'error');
      } else if (e.code !== 'unauthorized') {
        toast(`发送失败：${e.code}`, 'error');
      }
    } finally { setSendBusy(false); }
  }, [draft, files, hasContent, canSend, sessionId, modelOverride]);

  const onTaInput = (e) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  };
  const onTaKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  };

  const msgs = store.current.sorted;
  const title = meta?.title || sessionId.slice(0, 8);

  return html`
    <div class="page chat-page">
      <header class="topbar">
        <button class="icon-btn back" onClick=${goList} aria-label="返回">‹</button>
        <div class="topbar-mid">
          <div class="topbar-title serif ellip">${title}</div>
          <div class="topbar-sub"><span class="mono">${cwdTail(meta?.cwd || '')}</span> <${StatusBadge} status=${status} /></div>
        </div>
      </header>
      <div class="scroll msgs" ref=${scrollRef} onScroll=${onScroll}>
        <div class="msgs-inner">
          ${hasMore && html`<div class="load-older" onClick=${loadOlder}>↑ 加载更早消息</div>`}
          ${initLoading && html`<div class="empty">加载中…</div>`}
          ${loadErr && html`<div class="page-err">${loadErr}</div>`}
          ${!initLoading && !loadErr && msgs.length === 0 && html`<div class="empty">（空会话）</div>`}
          ${msgs.map((m) => html`<${MessageRow} key=${msgKey(m)} m=${m} />`)}
          ${pending && html`
            <div class="msg user pending">
              <span class="avatar user-avatar">我</span>
              <div class="bubble">${pending}</div>
              <div class="msg-time">发送中…</div>
            </div>`}
          ${runActive && html`
            <div class="msg assistant typing">
              <span class="avatar ai-avatar"><${Spark} /></span>
              <div class="msg-body"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
            </div>`}
        </div>
      </div>
      ${showJump && html`<button class="jump-btn" onClick=${() => { stick.current = true; const el = scrollRef.current; el.scrollTop = el.scrollHeight; setShowJump(false); }}>↓</button>`}
      <footer class="composer">
        ${isRunning && html`<div class="runbar"><span class="pulse"></span>Claude 正在运行… <button class="stop-link" onClick=${stopRun}>停止</button></div>`}
        ${!canSend && !isRunning && disabledReason && html`<div class="runbar muted">${disabledReason}</div>`}
        <div class="composer-card ${canSend ? '' : 'disabled'}">
          ${files.length > 0 && html`
            <div class="attach-chips">
              ${files.map((f, i) => html`
                <span class="chip" key=${`${f.name}:${i}`}>
                  <span class="chip-name">${truncate(f.name, 24)}</span>
                  <span class="chip-size">${fmtBytes(f.size)}</span>
                  <button class="chip-x" onClick=${() => removeFile(i)} aria-label="移除">✕</button>
                </span>`)}
            </div>`}
          <textarea ref=${taRef} rows="1" placeholder=${canSend ? '输入消息…' : disabledReason}
            value=${draft} disabled=${!canSend}
            onInput=${onTaInput} onKeyDown=${onTaKey}></textarea>
          <div class="composer-options">
            <${ModelPicker} catalog=${catalog} value=${modelOverride} onChange=${setModelOverride} compact=${true} />
            <span class="override-note">${modelOverride ? '仅本轮' : '跟随 Mac 默认'}</span>
          </div>
          <div class="composer-tools">
            <input ref=${fileRef} type="file" multiple hidden onChange=${onPickFiles} />
            <button class="tool-btn" title="上传文件" disabled=${!canSend} onClick=${() => fileRef.current?.click()}>+</button>
            <span class="flex1"></span>
            ${isRunning
              ? html`<button class="send-btn stop-btn" disabled=${false} onClick=${stopRun} aria-label="停止生成">■</button>`
              : html`<button class="send-btn" disabled=${!canSend || !hasContent} onClick=${doSend} aria-label="发送">↑</button>`}
          </div>
        </div>
      </footer>
    </div>`;
}

// ================================================================ 审批卡片

function Countdown({ expiresAt, stop }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stop) return; // 卡片已 resolved：停表，不再每秒 setState
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [stop]);
  const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const warn = left <= 20;
  return html`<span class="countdown ${warn ? 'warn' : ''}">${left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '已超时'}</span>`;
}

const RESOLVED_LABEL = { allowed: '已允许', denied: '已拒绝', answered: '已作答', expired: '已超时' };

function ApprovalCard({ item, onDecide }) {
  const it = item.interaction;
  const [busy, setBusy] = useState(false);
  const [denyMsg, setDenyMsg] = useState('');
  // question 状态：question -> { sel:Set<label>, free:string }
  const [answers, setAnswers] = useState(() => new Map((it.questions || []).map((q) => [q.question, { sel: new Set(), free: '' }])));

  const sess = sessionCache.get(it.sessionId);
  const sessLabel = sess?.title ? truncate(sess.title, 24) : it.sessionId.slice(0, 8);

  const decide = async (body) => {
    const status = body.type === 'deny' ? 'denied' : (body.type === 'answer' ? 'answered' : 'allowed');
    setBusy(true);
    // 乐观更新：戳立即渲染，HTTP 后台完成；移除计时由 ApprovalLayer.scheduleRemoval 负责。
    onDecide(it.interactionId, 'resolve', status);
    try {
      const data = await api(`/api/interactions/${encodeURIComponent(it.interactionId)}/decision`, { method: 'POST', body: JSON.stringify(body) });
      // HTTP 200：用响应体里的最终 status 校正本地标记
      if (data && data.status) onDecide(it.interactionId, 'resolve', data.status);
    } catch (e) {
      if (e.status === 409) toast('该审批已在别处处理', 'info');
      else if (e.status === 404) toast('审批已不存在', 'info');
      else {
        // 非 409/404 失败（含 unauthorized）：决策未落地，回滚为未决、取消移除计时
        onDecide(it.interactionId, 'rollback');
        if (e.code !== 'unauthorized') toast(`提交失败：${e.code}`, 'error');
      }
    } finally { setBusy(false); }
  };

  const setAns = (q, fn) => setAnswers((old) => {
    const next = new Map(old);
    const cur = next.get(q) || { sel: new Set(), free: '' };
    next.set(q, fn({ sel: new Set(cur.sel), free: cur.free }));
    return next;
  });
  const allAnswered = (it.questions || []).every((q) => {
    const a = answers.get(q.question);
    return a && (a.free.trim() || a.sel.size > 0);
  });
  const submitAnswers = () => {
    const out = {};
    for (const q of it.questions || []) {
      const a = answers.get(q.question);
      out[q.question] = a.free.trim() || [...a.sel].join(', ');
    }
    decide({ type: 'answer', answers: out });
  };

  return html`
    <div class="approval-card ${item.resolved ? 'resolved' : ''}">
      ${item.resolved && html`<div class="stamp ${item.resolved}">${RESOLVED_LABEL[item.resolved] || item.resolved}</div>`}
      <div class="ap-head">
        <span class="ap-kind">${it.kind === 'question' ? '❓ 提问' : '🔐 审批'}</span>
        <span class="ap-tool">${it.toolName || ''}</span>
        <${Countdown} expiresAt=${it.expiresAt} stop=${!!item.resolved} />
      </div>
      <div class="ap-sess">会话：${sessLabel}</div>
      ${it.prompt && html`<div class="ap-prompt">${it.prompt}</div>`}

      ${it.kind === 'approval' && html`
        <details class="block ap-input">
          <summary><span class="blk-ico">⚒</span><span class="blk-sub mono">${truncate(JSON.stringify(it.input ?? {}), 80)}</span></summary>
          <div class="blk-body"><pre class="mono">${JSON.stringify(it.input ?? {}, null, 2)}</pre></div>
        </details>
        <input class="deny-msg" placeholder="拒绝理由（可选）" value=${denyMsg} onInput=${(e) => setDenyMsg(e.target.value)} />
        <div class="ap-actions">
          <button class="btn deny" disabled=${busy || !!item.resolved} onClick=${() => decide(denyMsg.trim() ? { type: 'deny', message: denyMsg.trim() } : { type: 'deny' })}>拒绝</button>
          <button class="btn allow" disabled=${busy || !!item.resolved} onClick=${() => decide({ type: 'allow_once' })}>允许一次</button>
        </div>`}

      ${it.kind === 'question' && html`
        ${(it.questions || []).map((q) => {
          const a = answers.get(q.question) || { sel: new Set(), free: '' };
          return html`
            <div class="ap-q" key=${q.question}>
              ${q.header && html`<span class="q-chip">${q.header}</span>`}
              <div class="q-text">${q.question}${q.multiSelect ? html`<span class="q-multi">（可多选）</span>` : ''}</div>
              <div class="q-opts">
                ${(q.options || []).map((o) => {
                  const on = a.sel.has(o.label);
                  return html`
                    <button key=${o.label} class="q-opt ${on ? 'on' : ''}" disabled=${busy}
                      onClick=${() => setAns(q.question, (cur) => {
                        if (q.multiSelect) { cur.sel.has(o.label) ? cur.sel.delete(o.label) : cur.sel.add(o.label); }
                        else { cur.sel = cur.sel.has(o.label) ? new Set() : new Set([o.label]); }
                        return cur;
                      })}>
                      <span class="q-opt-label">${o.label}</span>
                      ${o.description && html`<span class="q-opt-desc">${o.description}</span>`}
                    </button>`;
                })}
              </div>
              <input class="q-free" placeholder="或自由输入…" value=${a.free}
                onInput=${(e) => setAns(q.question, (cur) => { cur.free = e.target.value; return cur; })} />
            </div>`;
        })}
        <div class="ap-actions">
          <button class="btn allow" disabled=${busy || !allAnswered || !!item.resolved} onClick=${submitAnswers}>提交回答</button>
        </div>`}
    </div>`;
}

function ApprovalLayer() {
  const [items, setItems] = useState([]); // {interaction, resolved?}
  // 幂等移除计时：本地乐观 resolve 与 WS resolved 都调用，仅首次调度生效，
  // 保证 WS 在本地已 resolved 后到达时只覆盖 status、不重置计时。
  const removalTimers = useRef(new Map());
  const scheduleRemoval = useCallback((id) => {
    if (removalTimers.current.has(id)) return;
    const t = setTimeout(() => {
      removalTimers.current.delete(id);
      setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id));
    }, 500);
    removalTimers.current.set(id, t);
  }, []);
  const cancelRemoval = useCallback((id) => {
    const t = removalTimers.current.get(id);
    if (t) { clearTimeout(t); removalTimers.current.delete(id); }
  }, []);
  useBus('ws:approval', ({ interaction }) => {
    setItems((xs) => (xs.some((x) => x.interaction.interactionId === interaction.interactionId) ? xs : [...xs, { interaction }]));
  }, []);
  useBus('ws:approval.resolved', ({ interactionId, status }) => {
    setItems((xs) => xs.map((x) => (x.interaction.interactionId === interactionId ? { ...x, resolved: status } : x)));
    scheduleRemoval(interactionId);
  }, []);
  // why: 'gone' 移除 | 'rollback' 回滚未决（取消计时）| 'resolve' 设置本地 resolved 状态
  const drop = (id, why, status) => {
    if (why === 'gone') { cancelRemoval(id); setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id)); return; }
    if (why === 'rollback') { cancelRemoval(id); setItems((xs) => xs.map((x) => (x.interaction.interactionId === id ? { ...x, resolved: null } : x))); return; }
    setItems((xs) => xs.map((x) => (x.interaction.interactionId === id ? { ...x, resolved: status } : x)));
    scheduleRemoval(id);
  };
  if (items.length === 0) return null;
  // 一次只展示最早的一张（避免堆叠超出屏幕），其余排队计数
  const current = items[0];
  return html`
    <div class="approval-layer">
      ${items.length > 1 && html`<div class="approval-queue">还有 ${items.length - 1} 个待处理</div>`}
      <${ApprovalCard} key=${current.interaction.interactionId} item=${current} onDecide=${drop} />
    </div>`;
}

// ================================================================ 视口高度（iOS 键盘）

function useVVH() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    return () => vv.removeEventListener('resize', set);
  }, []);
}

// ================================================================ 扫码配对深链（claude-remote://setup）

// 解析 claude-remote://setup?v=1&token=...&bases=<enc(url1)>,<enc(url2)>
// bases 里的 URL 各自 encodeURIComponent 后用逗号连接，故先按逗号切再逐个解码。
function parseSetupLink(url) {
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

// 确认卡：展示目标地址列表；覆盖已有配置前必须用户确认（防恶意二维码静默换 token）
function PairConfirm({ req, busy, onConfirm, onCancel }) {
  const hasExisting = !!(token || baseUrl);
  return html`
    <div class="pair-overlay">
      <div class="gate-card pair-confirm">
        <h1 class="serif">扫码配对</h1>
        <p class="gate-sub">将连接以下 Mac 地址（按顺序探测）：</p>
        <ul class="pair-bases">${req.bases.map((b) => html`<li key=${b} class="mono">${b}</li>`)}</ul>
        ${hasExisting && html`<p class="err">注意：确认后将覆盖当前已保存的连接配置。</p>`}
        <div class="ap-actions">
          <button class="btn deny" disabled=${busy} onClick=${onCancel}>取消</button>
          <button class="btn allow" disabled=${busy} onClick=${onConfirm}>${busy ? '连接中…' : '确认连接'}</button>
        </div>
      </div>
    </div>`;
}

// ================================================================ App

function App() {
  useVVH();
  const [auth, setAuth] = useState(token ? 'checking' : 'need'); // need | checking | ok
  const [authErr, setAuthErr] = useState('');
  const [route, setRoute] = useState(parseHash());

  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  useBus('unauthorized', () => {
    ws.stop();
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    setAuth('need');
    setAuthErr('token 已失效，请重新输入');
  }, []);
  useBus('logout', () => {
    ws.stop();
    saveConn('', '');
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(BASE_KEY);
    token = '';
    baseUrl = '';
    goList();
    setAuth('need');
    setAuthErr('');
  }, []);

  // 保存新配置并验证；成功返回 true（设置页复用）
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

  // 多候选连接：顺序探测 bases，首个成功者设为当前 bridge_base，完整候选表存 bridge_bases
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

  // 深链配对：非 Capacitor 壳环境无 App 插件，安全降级为不监听
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

  // 首次进入校验已存凭据：有候选表则顺序探测，否则按单地址直连
  useEffect(() => {
    if (!token) return;
    const bases = loadBases();
    if (bases.length > 0) tryConnectBases(bases, token);
    else tryConnect(baseUrl, token);
  }, []);

  const pairOverlay = pairReq && html`
    <${PairConfirm} req=${pairReq} busy=${pairBusy} onConfirm=${confirmPair} onCancel=${() => setPairReq(null)} />`;

  // #/pair 仅限 Mac 本机浏览器使用，不要求已配置连接
  if (route.view === 'pair') {
    return html`
      <${PairPage} />
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
      <${Sidebar} route=${route} />
      <main class="main">
        ${route.view === 'chat' ? html`<${Chat} key=${route.sessionId} sessionId=${route.sessionId} />`
        : route.view === 'settings' ? html`<${SettingsPage} onReconnect=${tryConnect} />`
        : html`<${StartScreen} />`}
      </main>
    </div>
    <${ApprovalLayer} />
    ${pairOverlay}
    <${ToastLayer} />`;
}

render(html`<${App} />`, document.getElementById('app'));
