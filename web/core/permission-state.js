import { t } from './i18n.js';

export function emptyPermissionState() {
  return { runId: null, requestedMode: null, effectiveMode: null, denials: [], notices: [], endedRuns: [] };
}

export function reducePermissionState(state, event) {
  if (event.type === 'identity') {
    if (event.runId === state.runId) return state;
    if (!event.runId) return { ...state, runId: null, requestedMode: null, effectiveMode: null,
      endedRuns: [...state.endedRuns, ...(state.runId ? [state.runId] : [])].slice(-100) };
    return { ...emptyPermissionState(), runId: event.runId,
      endedRuns: [...state.endedRuns, ...(state.runId ? [state.runId] : [])].slice(-100) };
  }
  if (event.type === 'session-state' || (event.type === 'run' && event.state === 'started')) {
    const runId = event.type === 'session-state' ? event.activeRunId : event.runId;
    if (runId && state.endedRuns.includes(runId)) return state;
    const next = reducePermissionState(state, { type: 'identity', runId: runId || null });
    if (!runId) return next;
    return { ...next,
      requestedMode: event.requestedPermissionMode ?? event.permissionMode ?? next.requestedMode ?? 'default',
      effectiveMode: event.type === 'session-state' ? event.effectivePermissionMode ?? null : next.effectiveMode,
    };
  }
  if (!state.runId || event.runId !== state.runId) return state;
  if (event.type === 'permission-mode') return { ...state, requestedMode: event.requestedMode ?? state.requestedMode, effectiveMode: event.effectiveMode };
  if (event.type === 'permission-denied' || event.type === 'agent-notice') {
    const key = event.type === 'permission-denied' ? 'denials' : 'notices';
    if (!event.eventId || state[key].some((item) => item.eventId === event.eventId)) return state;
    const items = key === 'denials' ? state[key].filter((item) => item.toolUseId !== event.toolUseId || item.agentId !== event.agentId) : state[key];
    return { ...state, [key]: [...items, event].slice(-100) };
  }
  return state;
}

const names = { default: '标准审批', acceptEdits: '自动编辑', plan: '规划', auto: '自动审核', bypassPermissions: 'Bypass' };
function modeName(mode) { return names[mode] ? t(names[mode]) : mode; }
export function permissionStatusText(state) {
  if (!state.runId || !state.requestedMode) return '';
  if (!state.effectiveMode) return t('{mode}，正在确认', { mode: modeName(state.requestedMode) });
  if (state.requestedMode === 'auto' && state.effectiveMode === 'default') return t('本轮已转为标准审批；CLI 未启用或已退出自动审核');
  const effective = names[state.effectiveMode]
    ? modeName(state.effectiveMode)
    : t('未知模式（{mode}）', { mode: state.effectiveMode });
  return t('本轮：{mode}', { mode: effective });
}

export function mergePermissionDenials(messages, denials) {
  const attached = new Map();
  const unmatched = [];
  for (const denial of denials) {
    const matches = messages.filter((message) => message.toolUseId === denial.toolUseId && (message.agentId || '') === (denial.agentId || ''));
    const target = matches.find((message) => message.kind === 'tool_result') || matches.find((message) => message.kind === 'tool_use');
    if (target) attached.set(target, denial);
    else unmatched.push(denial);
  }
  return { messages: messages.map((message) => attached.has(message) ? { ...message, permissionDenial: attached.get(message) } : message), unmatched };
}

const DENIAL_TEXT_MAP = {
  'User denied this action': '已手动拒绝该操作',
  'Permission denied: request cancelled': '审批已取消',
  'Interaction cancelled': '审批已取消',
  'Interaction timed out': '审批超时未处理',
  'Interaction denied after process restart': '服务重启，审批已失效',
  'Permission denied: no confirmed Gateway decision': '未收到有效的审批确认',
  'Invalid permission decision': '审批结果无效',
  'Question was not answered': '问题未作答',
};

function formatDenialLine(line) {
  if (!line) return '';
  const trimmed = String(line).trim();
  if (DENIAL_TEXT_MAP[trimmed]) return t(DENIAL_TEXT_MAP[trimmed]);
  if (/^approval channel failed closed(?::|$)/i.test(trimmed)) return t('审批通道异常中断');
  return String(line);
}

export function denialText(denial) {
  return [...new Set([denial.decisionReason, denial.message].map(formatDenialLine).filter(Boolean))].join('\n');
}

export function deniedToolResultText(denial, result) {
  return [...new Set([denial.decisionReason, denial.message, result].map(formatDenialLine).filter(Boolean))].join('\n');
}
