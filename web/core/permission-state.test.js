import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPermissionState, reducePermissionState, permissionStatusText, mergePermissionDenials, denialText, deniedToolResultText } from './permission-state.js';

test('mode facts remain distinct from requested mode and reset after run ends', () => {
  let state = reducePermissionState(emptyPermissionState(), { type: 'run', state: 'started', runId: 'A', permissionMode: 'auto' });
  assert.match(permissionStatusText(state), /自动审核，正在确认/);
  state = reducePermissionState(state, { type: 'permission-mode', runId: 'A', effectiveMode: 'default' });
  assert.match(permissionStatusText(state), /本轮已转为标准审批/);
  assert.equal(state.requestedMode, 'auto');
  state = reducePermissionState(state, { type: 'permission-mode', runId: 'A', effectiveMode: 'future' });
  assert.match(permissionStatusText(state), /未知模式（future）/);
  state = reducePermissionState(state, { type: 'session-state', activeRunId: null });
  assert.equal(permissionStatusText(state), '');
  assert.equal(reducePermissionState(state, { type: 'run', state: 'started', runId: 'A' }), state);
});

test('diagnostics dedupe by event and tool identity, require current run and stay bounded', () => {
  let state = reducePermissionState(emptyPermissionState(), { type: 'session-state', activeRunId: 'A', requestedPermissionMode: 'auto', effectivePermissionMode: 'auto' });
  const denial = { type: 'permission-denied', runId: 'A', eventId: 'deny', toolUseId: 'tu', message: 'Denied' };
  state = reducePermissionState(state, denial);
  assert.equal(reducePermissionState(state, denial), state);
  state = reducePermissionState(state, { ...denial, eventId: 'second' });
  assert.equal(state.denials.length, 1);
  state = reducePermissionState(state, { ...denial, eventId: 'child', agentId: 'child' });
  assert.equal(state.denials.length, 2);
  assert.equal(reducePermissionState(state, { ...denial, runId: 'old' }), state);
  for (let i = 0; i < 105; i++) state = reducePermissionState(state, { type: 'agent-notice', runId: 'A', eventId: `n-${i}`, message: 'Notice' });
  assert.equal(state.notices.length, 100);
});

test('denial attaches to one tool result, migrates from use, and never matches subagent by tool name', () => {
  const use = { kind: 'tool_use', toolUseId: 'tu', toolName: 'Bash' };
  const result = { kind: 'tool_result', toolUseId: 'tu', text: 'Denied', isError: true };
  const denial = { toolUseId: 'tu', toolName: 'Bash', decisionReason: 'Rule', message: 'Denied' };
  assert.equal(mergePermissionDenials([use], [denial]).messages[0].permissionDenial, denial);
  const merged = mergePermissionDenials([use, result], [denial]);
  assert.equal(merged.messages[0].permissionDenial, undefined);
  assert.equal(merged.messages[1].permissionDenial, denial);
  assert.deepEqual(merged.unmatched, []);
  assert.equal(mergePermissionDenials([use, result], [{ ...denial, agentId: 'child' }]).unmatched.length, 1);
  assert.equal(denialText({ message: 'Denied', decisionReason: 'Denied' }), 'Denied');
  assert.equal(deniedToolResultText({ decisionReason: 'Rule', message: 'Denied' }, 'Denied'), 'Rule\nDenied');
});
