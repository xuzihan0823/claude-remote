import { bus } from './bus.js';

export const TOKEN_KEY = 'bridge_token';
export const BASE_KEY = 'bridge_base';
export const BASES_KEY = 'bridge_bases';
export let token = localStorage.getItem(TOKEN_KEY) || '';
export let baseUrl = (localStorage.getItem(BASE_KEY) || '').trim().replace(/\/+$/, '');

export function loadBases() {
  try {
    const arr = JSON.parse(localStorage.getItem(BASES_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}
export function saveBases(bases) { localStorage.setItem(BASES_KEY, JSON.stringify(bases)); }

export function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}
export function saveConn(base, tok) {
  baseUrl = normalizeBase(base);
  token = tok;
  localStorage.setItem(BASE_KEY, baseUrl);
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() { token = ''; }
// location 仅浏览器同源部署（baseUrl 为空）时用到；RN 端无 location 但恒有显式 baseUrl
export function connHost() {
  if (baseUrl) { try { return new URL(baseUrl).host; } catch { return baseUrl; } }
  return typeof location === 'undefined' ? '' : location.host;
}
export function wsEndpoint() {
  const hasLoc = typeof location !== 'undefined';
  let host = hasLoc ? location.host : '';
  let secure = hasLoc && location.protocol === 'https:';
  let prefix = '';
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      host = u.host;
      secure = u.protocol === 'https:';
      prefix = u.pathname.replace(/\/+$/, '');
    } catch { /* 保底同源 */ }
  }
  return `${secure ? 'wss' : 'ws'}://${host}${prefix}/ws?token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data || {}; }
}
export function apiTimeoutMs(path) {
  if (path.startsWith('/api/health')) return 8_000;
  if (path.includes('/upload')) return 60_000;
  return 20_000;
}
export async function api(path, opts = {}) {
  const requestBase = baseUrl;
  const requestToken = token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? apiTimeoutMs(path));
  let res;
  try {
    res = await fetch(`${requestBase}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${requestToken}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, ctrl.signal.aborted ? 'network_timeout' : 'network_error');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (requestBase !== baseUrl || requestToken !== token) throw new ApiError(0, 'connection_changed');
  if (res.status === 401) { bus.emit('unauthorized'); throw new ApiError(401, 'unauthorized'); }
  if (!res.ok) throw new ApiError(res.status, data.error || `http_${res.status}`, data);
  return data;
}

export const PROBE_TIMEOUT_MS = 8_000;
export const DIRECT_GRACE_MS = 1_500;
const RELAY_PATH = /\/d\/[A-Za-z0-9_-]+$/;
/** relay 地址形如 https://relay.example.com/d/<deviceId>（relay 在反代子路径下时前面还有路径前缀），其余都是直连。 */
export function isRelayBase(base) {
  try { return RELAY_PATH.test(new URL(normalizeBase(base)).pathname.replace(/\/+$/, '')); } catch { return false; }
}

// opts 供测试注入：fetchImpl / timers（setTimeout + clearTimeout）/ signal（外部中止）/ timeoutMs
export async function probeBase(base, tok, opts = {}) {
  const { fetchImpl = globalThis.fetch, timers = globalThis, signal, timeoutMs = PROBE_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchImpl(`${base}/api/health`, { headers: { Authorization: `Bearer ${tok}` }, signal: ctrl.signal });
    if (res.status === 401) throw new ApiError(401, 'unauthorized');
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, timedOut ? 'network_timeout' : 'network_error');
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 并行探测同一台 Mac 的全部候选地址，返回选中的 base：
 * 直连先通即用；relay 先通则再等 DIRECT_GRACE_MS 给直连机会；任一 401 立即抛；全失败抛最后一个错误。
 * 决定后中止其余进行中的探测。
 */
export function probeBases(bases, tok, opts = {}) {
  const { timers = globalThis, graceMs = DIRECT_GRACE_MS } = opts;
  const list = [];
  for (const raw of bases || []) {
    const b = normalizeBase(raw);
    if (b && !list.includes(b)) list.push(b);
  }
  if (!list.length) return Promise.reject(new ApiError(0, 'network_error'));
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    let done = false;
    let pending = list.length;
    let relayHit = '';
    let graceTimer = null;
    let lastErr = new ApiError(0, 'network_error');
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (graceTimer !== null) timers.clearTimeout(graceTimer);
      ctrl.abort();
      fn(value);
    };
    const settled = () => {
      if (--pending > 0) return;
      if (relayHit) finish(resolve, relayHit);
      else finish(reject, lastErr);
    };
    for (const base of list) {
      probeBase(base, tok, { ...opts, signal: ctrl.signal }).then(() => {
        if (done) return;
        if (!isRelayBase(base)) { finish(resolve, base); return; }
        if (!relayHit) {
          relayHit = base;
          graceTimer = timers.setTimeout(() => finish(resolve, relayHit), graceMs);
        }
        settled();
      }, (e) => {
        if (done) return;
        if (e.code === 'unauthorized') { finish(reject, e); return; }
        lastErr = e;
        settled();
      });
    }
  });
}
export function connErrMsg(e) {
  if (e.code === 'unauthorized') return 'token 不正确';
  if (e.code === 'network_timeout') return '连接超时（Mac 不可达）：检查 Mac 上 daemon 是否在跑，以及 Tailscale 或 relay 是否可用';
  return '无法连接 daemon（地址或网络错误）';
}

export const sessionCache = new Map();
export const pendingSessionMessages = new Map();
const EMPTY_MODEL_CATALOG = { models: [], defaultModel: '', loaded: false };
export let modelCache = EMPTY_MODEL_CATALOG;
export function cacheSessions(list) { for (const s of list) sessionCache.set(s.sessionId, s); }
export async function fetchSessions(limit = 100, { offset = 0, projectId, cwd } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (projectId !== undefined) params.set('projectId', projectId);
  if (cwd !== undefined) params.set('cwd', cwd);
  const requestBase = baseUrl;
  const requestToken = token;
  const d = await api(`/api/sessions?${params}`);
  if (requestBase === baseUrl && requestToken === token) {
    cacheSessions(d.sessions);
    bus.emit('sessions-cached');
  }
  return d;
}
/** GET /api/sessions/search。full=true 时 daemon 会扫 JSONL 全文（较慢）。 */
export async function searchSessionsApi(q, { full = false, limit = 30 } = {}) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (full) params.set('full', '1');
  const d = await api(`/api/sessions/search?${params}`, { timeoutMs: full ? 30_000 : undefined });
  cacheSessions(d.results || []);
  return d;
}
export async function fetchProjects() {
  return api('/api/projects');
}
export async function fetchModels() {
  const d = await api('/api/models');
  modelCache = {
    models: Array.isArray(d.models) ? d.models : [],
    defaultModel: typeof d.defaultModel === 'string' ? d.defaultModel : '',
    loaded: true,
  };
  bus.emit('models-cached', modelCache);
  return modelCache;
}
export function resetModelCache() {
  modelCache = EMPTY_MODEL_CATALOG;
  bus.emit('models-cached', modelCache);
}
export function modelValue(model) { return model.alias || model.id || ''; }
export function modelLabel(model) { return model.displayName || model.alias || model.id || '未命名模型'; }
export function modelMainName(model) { return model.id || model.alias || '未命名模型'; }
export function findModel(models, value) {
  if (!value) return null;
  return models.find((m) => m.alias === value || m.id === value) || null;
}
// daemon 无条件接受的内置别名（packages/daemon/src/model-config.ts MODEL_ALIASES）
const BUILTIN_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
/**
 * 选择值的状态。只有 '' 表示跟随默认；找不到的非空值不能当成默认，否则显示与实际发送不一致。
 * status: default | ok | unavailable（目录已加载但没有它）| unverified（目录还没成功加载）
 */
export function modelSelection(catalog, value) {
  if (!value) return { status: 'default', model: null };
  const model = findModel(catalog?.models || [], value);
  if (model) return { status: 'ok', model };
  if (BUILTIN_MODEL_ALIASES.includes(value)) return { status: 'ok', model: { id: value, alias: value } };
  return { status: catalog?.loaded ? 'unavailable' : 'unverified', model: null };
}
/** 模型选择器按钮上的文字，与 modelSelection 的状态一一对应。 */
export function modelTriggerLabel(catalog, value) {
  const { status, model } = modelSelection(catalog, value);
  if (status === 'ok') return modelMainName(model);
  if (status === 'unavailable') return `${value}（不可用）`;
  if (status === 'unverified') return value;
  return '跟随项目默认';
}

// 每个会话记住手机上为它选的模型：续聊不带 model 时会回到项目默认模型，
// 不记住的话，新建时选的模型在进入会话页后就被悄悄换掉
const SESSION_MODEL_KEY = 'session_model';
export function getSessionModel(sessionId) {
  try { return localStorage.getItem(`${SESSION_MODEL_KEY}:${sessionId}`) || ''; }
  catch { return ''; }
}
export function setSessionModel(sessionId, model) {
  try {
    if (model) localStorage.setItem(`${SESSION_MODEL_KEY}:${sessionId}`, model);
    else localStorage.removeItem(`${SESSION_MODEL_KEY}:${sessionId}`);
  } catch { /* localStorage 不可用时仅放弃持久化 */ }
}

export function resolveDefaultName(catalog) {
  const { models = [], defaultModel = '' } = catalog || {};
  if (!defaultModel) return '';
  const m = findModel(models, defaultModel);
  return m ? modelMainName(m) : defaultModel;
}

export function defaultModelDescription(catalog) {
  const name = resolveDefaultName(catalog);
  return `${name ? `用户配置默认：${name}；` : ''}实际运行遵循当前项目配置`;
}
