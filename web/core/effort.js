import { api, baseUrl, modelTriggerLabel, normalizeBase, token } from './api.js';
import { currentDeviceId, getDevice, loadDevices } from './devices.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_EFFORT = '';
export const SESSION_EFFORT_KEY = 'session_effort';

export const EFFORT_LABELS = {
  '': '跟随默认',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};

export const EFFORT_DESCRIPTIONS = {
  '': '遵循本机与项目当前思考配置',
  low: '轻量思考，响应更快',
  medium: '均衡思考深度与速度',
  high: '深入推理复杂问题',
  xhigh: '高强度深度思考',
  max: '最高思考程度，通常耗时更长',
};

export const EMPTY_CAPABILITIES = Object.freeze({
  status: 'unknown',
  effortLevels: [],
  source: 'unknown',
  revision: '',
  thinkingEnabled: true,
  reason: '',
  loaded: false,
});

export function isValidEffortLevel(value) {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value);
}

export function effortLabel(value) {
  if (!value) return EFFORT_LABELS[''];
  return EFFORT_LABELS[value] || String(value);
}

export function normalizeCapabilities(raw, { loaded = true } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_CAPABILITIES, loaded: Boolean(loaded) };
  }
  const status = raw.status === 'known' || raw.status === 'unsupported' || raw.status === 'unknown'
    ? raw.status
    : 'unknown';
  const effortLevels = status === 'unsupported'
    ? []
    : EFFORT_LEVELS.filter((level) => Array.isArray(raw.effortLevels) && raw.effortLevels.includes(level));
  const source = raw.source === 'claude' || raw.source === 'magpie' || raw.source === 'unknown'
    ? raw.source
    : 'unknown';
  const revision = typeof raw.revision === 'string' ? raw.revision : '';
  const thinkingEnabled = raw.thinkingEnabled !== false;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return {
    status,
    effortLevels,
    source,
    revision,
    thinkingEnabled,
    reason,
    loaded: Boolean(loaded),
  };
}

export function buildCapabilitiesPath({ cwd, sessionId, model, refresh } = {}) {
  const params = new URLSearchParams();
  if (sessionId !== undefined && sessionId !== null && String(sessionId).trim() !== '') {
    params.set('sessionId', String(sessionId).trim());
  } else if (cwd !== undefined && cwd !== null && String(cwd).trim() !== '') {
    params.set('cwd', String(cwd).trim());
  }
  if (typeof model === 'string' && model.trim() !== '') {
    params.set('model', model.trim());
  }
  if (refresh) {
    params.set('refresh', '1');
  }
  const qs = params.toString();
  return qs ? `/api/model-capabilities?${qs}` : '/api/model-capabilities';
}

export async function fetchModelCapabilities(query = {}, apiImpl = api) {
  const data = await apiImpl(buildCapabilitiesPath(query));
  return normalizeCapabilities(data, { loaded: true });
}

export function resolveDeviceKey(explicitDeviceId) {
  if (typeof explicitDeviceId === 'string' && explicitDeviceId.trim() !== '') {
    return explicitDeviceId.trim();
  }
  try {
    const curId = currentDeviceId();
    const normBase = normalizeBase(baseUrl);
    if (curId) {
      const dev = getDevice(curId);
      if (dev && (!normBase || dev.bases.includes(normBase) || (token && dev.token === token))) {
        return curId;
      }
    }
    if (normBase || token) {
      const matched = loadDevices().find(
        (d) => (token && d.token === token) || (normBase && d.bases.includes(normBase)),
      );
      if (matched) return matched.id;
    }
  } catch { /* fallback to baseUrl */ }
  return normalizeBase(baseUrl) || 'default';
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function removeStorage(key) {
  try {
    if (typeof localStorage.removeItem === 'function') localStorage.removeItem(key);
    else localStorage.setItem(key, '');
  } catch { /* ignore */ }
}

function parseSessionEffortData(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function getSessionEffort(sessionId, { model, deviceId } = {}) {
  const activeDevice = resolveDeviceKey(deviceId);
  const fallbackModel = typeof model === 'string' ? model : '';
  const empty = { effort: '', model: fallbackModel, revision: '', deviceId: activeDevice, stale: false, staleReason: '' };
  if (!sessionId) return empty;
  const parsed = parseSessionEffortData(readStorage(`${SESSION_EFFORT_KEY}:${sessionId}`));
  if (!parsed || typeof parsed.effort !== 'string' || !parsed.effort) return empty;
  const recordedDevice = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
  const recordedModel = typeof parsed.model === 'string' ? parsed.model : '';
  const recordedRevision = typeof parsed.revision === 'string' ? parsed.revision : '';
  if (recordedDevice && activeDevice && recordedDevice !== activeDevice) {
    return {
      effort: parsed.effort,
      model: recordedModel,
      revision: recordedRevision,
      deviceId: recordedDevice,
      stale: true,
      staleReason: 'device_changed',
    };
  }
  return {
    effort: parsed.effort,
    model: recordedModel,
    revision: recordedRevision,
    deviceId: recordedDevice || activeDevice,
    stale: Boolean(parsed.stale),
    staleReason: typeof parsed.staleReason === 'string' ? parsed.staleReason : '',
  };
}

export function setSessionEffort(sessionId, effortOrRecord, opts = {}) {
  const input = typeof effortOrRecord === 'object' && effortOrRecord !== null
    ? effortOrRecord
    : { effort: effortOrRecord, ...opts };
  const effort = typeof input.effort === 'string' ? input.effort : '';
  const model = typeof input.model === 'string' ? input.model : '';
  const revision = typeof input.revision === 'string' ? input.revision : '';
  const deviceId = resolveDeviceKey(input.deviceId);
  const record = {
    effort,
    model,
    revision,
    deviceId,
    stale: Boolean(input.stale && effort),
    staleReason: effort && input.staleReason ? String(input.staleReason) : '',
  };
  if (!sessionId) return record;
  const storageKey = `${SESSION_EFFORT_KEY}:${sessionId}`;
  if (!effort) {
    removeStorage(storageKey);
    return { effort: '', model, revision: '', deviceId, stale: false, staleReason: '' };
  }
  writeStorage(storageKey, JSON.stringify(record));
  return record;
}

export function clearSessionEffort(sessionId, opts = {}) {
  return setSessionEffort(sessionId, '', opts);
}

/**
 * 评估当前思考程度选择在给定能力与上下文下的有效性。
 * status:
 * - 'default': 跟随本机默认（effort === ''），不发送字段
 * - 'ok': 能力已知且档位受支持
 * - 'manual': 能力 unknown 且手动选择了标准五档之一（允许发送）
 * - 'unverified': 能力尚未加载完成
 * - 'stale': 设备或后端能力配置 revision 已变化，需用户重新确认或清除
 * - 'thinking_disabled': 本机已关闭思考（thinkingEnabled === false），旧非空选择不可发送
 * - 'unavailable': 当前模型不支持思考调整或不支持该档位
 * - 'invalid': 非法档位值
 */
export function effortSelection(capabilities, selection, context = {}) {
  const rec = typeof selection === 'object' && selection !== null
    ? selection
    : { effort: typeof selection === 'string' ? selection : '' };
  const effort = typeof rec.effort === 'string' ? rec.effort : '';
  const recordedRevision = typeof rec.revision === 'string' ? rec.revision : '';
  const recordedDevice = typeof rec.deviceId === 'string' ? rec.deviceId : '';
  const currentDevice = context.deviceId !== undefined ? resolveDeviceKey(context.deviceId) : '';
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : EMPTY_CAPABILITIES;
  const loaded = Boolean(caps.loaded);

  if (!effort) {
    return {
      status: 'default',
      effort: '',
      canSend: true,
      sendEffort: undefined,
      badge: '',
      message: '',
    };
  }

  if (!isValidEffortLevel(effort)) {
    return {
      status: 'invalid',
      effort,
      canSend: false,
      sendEffort: undefined,
      badge: `${effortLabel(effort)}（不可用）`,
      message: '所选思考程度无效，请重新选择或恢复默认',
    };
  }

  const deviceChanged = Boolean(recordedDevice && currentDevice && recordedDevice !== currentDevice);
  const revisionChanged = Boolean(loaded && recordedRevision && caps.revision && recordedRevision !== caps.revision);
  if (rec.stale || deviceChanged || revisionChanged) {
    return {
      status: 'stale',
      effort,
      canSend: false,
      sendEffort: undefined,
      reason: deviceChanged || rec.staleReason === 'device_changed' ? 'device_changed' : 'revision_changed',
      badge: `${effortLabel(effort)}（需重选）`,
      message: '连接或本机思考配置已变化，请重新选择思考程度或恢复默认',
    };
  }

  if (!loaded) {
    return {
      status: 'unverified',
      effort,
      canSend: true,
      sendEffort: effort,
      badge: effortLabel(effort),
      message: '',
    };
  }

  if (caps.thinkingEnabled === false) {
    return {
      status: 'thinking_disabled',
      effort,
      canSend: false,
      sendEffort: undefined,
      reason: 'thinking_disabled',
      badge: `${effortLabel(effort)}（思考已关）`,
      message: '本机已关闭思考，档位不会生效，请恢复跟随默认后再发送',
    };
  }

  if (caps.status === 'unsupported') {
    return {
      status: 'unavailable',
      effort,
      canSend: false,
      sendEffort: undefined,
      reason: 'unsupported_model',
      badge: `${effortLabel(effort)}（不可用）`,
      message: '当前模型不支持调整思考程度，请清除旧选择后再发送',
    };
  }

  if (caps.status === 'known') {
    const levels = Array.isArray(caps.effortLevels) ? caps.effortLevels : [];
    if (!levels.includes(effort)) {
      return {
        status: 'unavailable',
        effort,
        canSend: false,
        sendEffort: undefined,
        reason: 'level_not_supported',
        badge: `${effortLabel(effort)}（不可用）`,
        message: `当前模型不支持「${effortLabel(effort)}」思考程度，请重新选择或恢复默认`,
      };
    }
    return {
      status: 'ok',
      effort,
      canSend: true,
      sendEffort: effort,
      badge: effortLabel(effort),
      message: '',
    };
  }

  return {
    status: 'manual',
    effort,
    canSend: true,
    sendEffort: effort,
    badge: effortLabel(effort),
    message: '兼容性未确认（手动指定）',
  };
}

/**
 * 若存储的会话思考档位在创建时尚未绑定 revision（例如能力查询未返回前已创建会话），
 * 首次拿到有效能力且档位合法时绑定当前 revision；若原已有 revision 且发生变化则保持过期状态。
 */
export function syncSessionEffortRevision(sessionId, capabilities, { model = '', deviceId } = {}) {
  const rec = getSessionEffort(sessionId, { model, deviceId });
  if (!rec.effort || rec.stale || rec.revision) return rec;
  if (!capabilities?.loaded || !capabilities.revision) return rec;
  const sel = effortSelection(capabilities, rec, { model, deviceId });
  if (!sel.canSend) return rec;
  return setSessionEffort(sessionId, {
    effort: rec.effort,
    model: model || rec.model,
    revision: capabilities.revision,
    deviceId: rec.deviceId,
  });
}

export function modelEffortTriggerLabel(catalog, modelValue, capabilities, selection, context = {}) {
  const main = modelTriggerLabel(catalog, modelValue);
  const { badge } = effortSelection(capabilities, selection, context);
  return badge ? `${main} · ${badge}` : main;
}

export function capabilityTargetKey({ cwd, sessionId, model, deviceId } = {}) {
  const dev = resolveDeviceKey(deviceId);
  const sid = sessionId !== undefined && sessionId !== null ? String(sessionId).trim() : '';
  const dir = !sid && cwd !== undefined && cwd !== null ? String(cwd).trim() : '';
  const mdl = typeof model === 'string' ? model.trim() : '';
  if (!sid && !dir) return '';
  return `${dev}\n${sid}\n${dir}\n${mdl}`;
}

export function createCapabilitiesLoader({
  apiImpl = api,
  getDeviceKey = resolveDeviceKey,
  getConn = () => ({ baseUrl, token }),
  onUpdate,
} = {}) {
  let requestSeq = 0;
  let activeKey = '';
  let state = { ...EMPTY_CAPABILITIES, loading: false, error: '' };

  const publish = (next) => {
    state = next;
    onUpdate?.(state);
    return state;
  };

  return {
    getState: () => state,
    reset() {
      requestSeq += 1;
      activeKey = '';
      return publish({ ...EMPTY_CAPABILITIES, loading: false, error: '' });
    },
    applyCapabilities(raw, target = {}) {
      const key = capabilityTargetKey({ ...target, deviceId: getDeviceKey(target.deviceId) });
      if (key && activeKey && key !== activeKey) return state;
      if (key) activeKey = key;
      requestSeq += 1;
      const normalized = normalizeCapabilities(raw, { loaded: true });
      return publish({ ...normalized, loading: false, error: '' });
    },
    async load(target = {}) {
      const devKey = getDeviceKey(target.deviceId);
      const key = capabilityTargetKey({ ...target, deviceId: devKey });
      if (!key) {
        requestSeq += 1;
        activeKey = '';
        return publish({ ...EMPTY_CAPABILITIES, loading: false, error: '' });
      }
      const seq = ++requestSeq;
      const conn = getConn();
      const sameTarget = key === activeKey;
      activeKey = key;
      publish({
        ...(sameTarget && state.loaded ? state : EMPTY_CAPABILITIES),
        loading: true,
        error: '',
      });
      try {
        const caps = await fetchModelCapabilities(
          { cwd: target.cwd, sessionId: target.sessionId, model: target.model, refresh: Boolean(target.refresh) },
          apiImpl,
        );
        const nowConn = getConn();
        const nowDev = getDeviceKey(target.deviceId);
        if (
          seq !== requestSeq ||
          key !== activeKey ||
          conn.baseUrl !== nowConn.baseUrl ||
          conn.token !== nowConn.token ||
          devKey !== nowDev
        ) {
          return null;
        }
        return publish({ ...caps, loading: false, error: '' });
      } catch (err) {
        const nowConn = getConn();
        const nowDev = getDeviceKey(target.deviceId);
        if (
          seq !== requestSeq ||
          key !== activeKey ||
          conn.baseUrl !== nowConn.baseUrl ||
          conn.token !== nowConn.token ||
          devKey !== nowDev
        ) {
          return null;
        }
        return publish({
          ...(sameTarget && state.loaded ? state : EMPTY_CAPABILITIES),
          loading: false,
          error: err?.code || 'network_error',
        });
      }
    },
  };
}
