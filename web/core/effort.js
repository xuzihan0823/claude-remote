import { api } from './api.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SESSION_EFFORT_KEY = 'session_effort';

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

export function effortLabel(value) {
  return EFFORT_LABELS[value || ''] || String(value);
}

export function getSessionEffort(sessionId) {
  try {
    const value = localStorage.getItem(`${SESSION_EFFORT_KEY}:${sessionId}`) || '';
    return EFFORT_LEVELS.includes(value) ? value : '';
  } catch { return ''; }
}

export function setSessionEffort(sessionId, effort) {
  try {
    if (effort) localStorage.setItem(`${SESSION_EFFORT_KEY}:${sessionId}`, effort);
    else localStorage.removeItem(`${SESSION_EFFORT_KEY}:${sessionId}`);
  } catch { /* localStorage 不可用时仅放弃持久化 */ }
}

export function effortLevelsPath({ sessionId, cwd, model } = {}) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  else if (cwd) params.set('cwd', cwd);
  if (model) params.set('model', model);
  return `/api/effort-levels?${params}`;
}

// 返回 { levels, verified }：verified=true 表示档位来自本机 Magpie 网关；否则五档全部开放。
export async function fetchEffortLevels(query, apiImpl = api) {
  const data = await apiImpl(effortLevelsPath(query));
  const levels = EFFORT_LEVELS.filter((l) => Array.isArray(data?.levels) && data.levels.includes(l));
  return data?.verified === true ? { levels, verified: true } : { levels: [...EFFORT_LEVELS], verified: false };
}

// 只有网关明确给出档位、且不含所选档位时才算不可用；未确认时一律放行。
export function effortUsable(options, effort) {
  return !effort || !options?.verified || options.levels.includes(effort);
}
