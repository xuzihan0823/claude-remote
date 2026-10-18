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
  } catch {
    throw new ApiError(0, ctrl.signal.aborted ? 'network_timeout' : 'network_error');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { bus.emit('unauthorized'); throw new ApiError(401, 'unauthorized'); }
  if (!res.ok) throw new ApiError(res.status, data.error || `http_${res.status}`, data);
  return data;
}

export async function probeBase(base, tok) {
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
export async function probeBases(bases, tok) {
  let lastErr = new ApiError(0, 'network_error');
  for (const raw of bases) {
    const base = normalizeBase(raw);
    if (!base) continue;
    try { await probeBase(base, tok); return base; }
    catch (e) { if (e.code === 'unauthorized') throw e; lastErr = e; }
  }
  throw lastErr;
}
export function connErrMsg(e) {
  if (e.code === 'unauthorized') return 'token 不正确';
  if (e.code === 'network_timeout') return '连接超时（Mac 不可达）：检查 Mac 上 daemon 是否在跑、Tailscale 是否开启';
  return '无法连接 daemon（地址或网络错误）';
}

export const sessionCache = new Map();
export const pendingSessionMessages = new Map();
export let modelCache = { models: [], defaultModel: '' };
export function cacheSessions(list) { for (const s of list) sessionCache.set(s.sessionId, s); }
export async function fetchSessions(limit = 100) {
  const d = await api(`/api/sessions?limit=${limit}`);
  cacheSessions(d.sessions);
  bus.emit('sessions-cached');
  return d;
}
export async function fetchModels() {
  const d = await api('/api/models');
  modelCache = {
    models: Array.isArray(d.models) ? d.models : [],
    defaultModel: typeof d.defaultModel === 'string' ? d.defaultModel : '',
  };
  bus.emit('models-cached', modelCache);
  return modelCache;
}
export function modelValue(model) { return model.alias || model.id || ''; }
export function modelLabel(model) { return model.displayName || model.alias || model.id || '未命名模型'; }
export function modelMainName(model) { return model.id || model.alias || '未命名模型'; }
export function findModel(models, value) {
  if (!value) return null;
  return models.find((m) => m.alias === value || m.id === value) || null;
}
export function resolveDefaultName(catalog) {
  const { models = [], defaultModel = '' } = catalog || {};
  if (!defaultModel) return '';
  const m = findModel(models, defaultModel);
  return m ? modelMainName(m) : defaultModel;
}
