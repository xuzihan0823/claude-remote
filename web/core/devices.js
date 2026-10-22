// 已配对设备（Mac）列表。每台 Mac 一个 daemon、一个 BRIDGE_TOKEN、若干候选地址（Tailscale / 局域网…）。
// 当前连接仍由 api.js 的 baseUrl/token 表示；这里只负责记住「有哪些 Mac」以及切换时用哪组凭据。
// 旧版本只存一台（bridge_base / bridge_bases / bridge_token），首次读取时迁移成一条设备记录。
import { BASE_KEY, BASES_KEY, TOKEN_KEY, normalizeBase } from './api.js';

export const DEVICES_KEY = 'bridge_devices';
export const CURRENT_DEVICE_KEY = 'bridge_device_current';

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function hostOf(base) {
  try { return new URL(normalizeBase(base)).host; } catch { return String(base || ''); }
}

/** daemon 上报的主机名 → 显示名：去掉 .local，空则用地址。 */
export function displayName(hostname, base) {
  const h = String(hostname || '').replace(/\.local\.?$/i, '').trim();
  return h || hostOf(base) || 'Mac';
}

const uniqBases = (list) => {
  const out = [];
  for (const raw of list || []) {
    const b = normalizeBase(raw);
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
};

function read() {
  try {
    const raw = localStorage.getItem(DEVICES_KEY);
    if (raw == null) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((d) => d && d.id && Array.isArray(d.bases)) : [];
  } catch { return []; }
}

function write(list) { localStorage.setItem(DEVICES_KEY, JSON.stringify(list)); }

function migrateLegacy() {
  const tok = localStorage.getItem(TOKEN_KEY) || '';
  const base = normalizeBase(localStorage.getItem(BASE_KEY) || '');
  let bases = [];
  try { bases = JSON.parse(localStorage.getItem(BASES_KEY) || '[]'); } catch { bases = []; }
  bases = uniqBases([base, ...(Array.isArray(bases) ? bases : [])]);
  if (!tok || !bases.length) return [];
  const d = { id: newId(), name: hostOf(bases[0]), bases, token: tok, lastBase: base || bases[0], lastConnectedAt: Date.now() };
  localStorage.setItem(CURRENT_DEVICE_KEY, d.id);
  return [d];
}

export function loadDevices() {
  let list = read();
  if (list === null) { list = migrateLegacy(); write(list); }
  return list;
}

export function getDevice(id) { return loadDevices().find((d) => d.id === id) || null; }
export function currentDeviceId() {
  const id = localStorage.getItem(CURRENT_DEVICE_KEY) || '';
  return loadDevices().some((d) => d.id === id) ? id : '';
}
export function setCurrentDevice(id) { localStorage.setItem(CURRENT_DEVICE_KEY, id || ''); }

/** 设备列表排序：当前设备在前，其余按最近连接时间。 */
export function sortedDevices(list = loadDevices(), cur = currentDeviceId()) {
  return [...list].sort((a, b) => (b.id === cur) - (a.id === cur) || (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0));
}

/**
 * 连接成功后记下这台设备。匹配规则：同 token 视为同一台；否则地址有交集视为同一台（token 换过）。
 * 新地址排在前面（刚连通的最可能还能用），保留原有其他地址。返回该设备并设为当前。
 */
export function upsertDevice({ bases, base, token, name }) {
  const list = loadDevices();
  const connected = normalizeBase(base || bases?.[0] || '');
  const incoming = uniqBases([connected, ...(bases || [])]);
  let d = list.find((x) => x.token === token)
    || list.find((x) => x.bases.some((b) => incoming.includes(b)));
  if (d) {
    d.token = token;
    d.bases = uniqBases([...incoming, ...d.bases]);
    if (name && !d.nameEdited) d.name = name;
  } else {
    d = { id: newId(), name: name || hostOf(connected), bases: incoming, token };
    list.push(d);
  }
  d.lastBase = connected;
  d.lastConnectedAt = Date.now();
  write(list);
  setCurrentDevice(d.id);
  return d;
}

export function updateDevice(id, patch) {
  const list = loadDevices();
  const d = list.find((x) => x.id === id);
  if (!d) return null;
  if (patch.name !== undefined) { d.name = String(patch.name).trim() || d.name; d.nameEdited = true; }
  if (patch.bases !== undefined) d.bases = uniqBases(patch.bases);
  if (patch.token !== undefined) d.token = patch.token;
  if (patch.autoName && !d.nameEdited) d.name = patch.autoName;
  if (patch.info !== undefined) d.info = { ...(d.info || {}), ...patch.info };
  write(list);
  return d;
}

/** 删除设备；返回删除后应切换到的设备（删的是当前设备时，取最近连接的另一台），没有则 null。 */
export function removeDevice(id) {
  const wasCurrent = currentDeviceId() === id;
  const list = loadDevices().filter((d) => d.id !== id);
  write(list);
  if (!wasCurrent) return null;
  const next = sortedDevices(list, '')[0] || null;
  setCurrentDevice(next ? next.id : '');
  return next;
}

/** 切换设备时按顺序尝试的地址：上次连通的优先。 */
export function candidateBases(d) {
  return uniqBases([d.lastBase, ...d.bases]);
}
