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
export function permissionStatusText(state) {
  if (!state.runId || !state.requestedMode) return '';
  if (!state.effectiveMode) return `${names[state.requestedMode] || state.requestedMode}，正在确认`;
  if (state.requestedMode === 'auto' && state.effectiveMode === 'default') return '本轮已转为标准审批；CLI 未启用或已退出自动审核';
  return `本轮：${names[state.effectiveMode] || `未知模式（${state.effectiveMode}）`}`;
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

export function denialText(denial) {
  return [...new Set([denial.decisionReason, denial.message].filter(Boolean))].join('\n');
}

export function deniedToolResultText(denial, result) {
  return [...new Set([denial.decisionReason, denial.message, result].filter(Boolean))].join('\n');
}
