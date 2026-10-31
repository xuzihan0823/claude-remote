import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys } from '../../../../web/core/stream-drafts.js';
import { newClientMessageId, reconcilePending, sendFailureState } from '../../../../web/core/message-delivery.js';

const storageValues = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  };
}
const { effortLabel, effortUsable, getSessionEffort, setSessionEffort } = await import('../../../../web/core/effort.js');
const screenSource = readFileSync(new URL('../../screens/ChatScreen.js', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../../components/composer/ChatComposer.js', import.meta.url), 'utf8');
const newComposerSource = readFileSync(new URL('../../components/composer/NewChatComposer.js', import.meta.url), 'utf8');
const approvalSource = readFileSync(new URL('../../components/ApprovalLayer.js', import.meta.url), 'utf8');
// Execute the component's actual state/event code, excluding native rendering and imports.
function mount(source, start, end, exposed, initialProps, dependencies) {
  const slots = [];
  const effects = [];
  const handlers = new Map();
  const timers = new Map();
  let cursor = 0;
  let timerId = 0;
  let props = initialProps;
  let current;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (update) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        effects[index] = { fn, deps, cleanup: previous?.cleanup, pending: true };
      }
    },
    useBus(name, handler) { handlers.set(name, handler); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    ...dependencies,
  };
  let bodyStart = source.indexOf(start) + start.length;
  let header = '';
  if (start.endsWith('({')) {
    const headerEnd = source.indexOf('}) {', bodyStart);
    header = `const {${source.slice(bodyStart, headerEnd)}} = props;\n`;
    bodyStart = headerEnd + 4;
  }
  const body = source.slice(bodyStart, source.indexOf(end));
  const run = new Function('props', ...Object.keys(hooks), `${header}${body}\nreturn { ${exposed} };`);
  return {
    render(nextProps = props) {
      props = nextProps;
      cursor = 0;
      current = run(props, ...Object.values(hooks));
      // Run effects only on demand: production renders do not rerun unchanged effects.
      return current;
    },
    effects() {
      for (const effect of effects) {
        if (!effect?.pending) continue;
        effect.cleanup?.();
        effect.cleanup = effect.fn();
        effect.pending = false;
      }
    },
    emit(name, frame) { return handlers.get(name)?.(frame); },
    flushTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    unmount() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

function screen(api = async () => ({ messages: [], firstSeq: null, hasMore: false }), dependencies = {}) {
  const instance = mount(screenSource, 'export function ChatScreen({ route }) {', '  const kbOffset =',
    'pending, onSendFailed, drafts, store, runActive, activeRunId, status, addMsgs, onSending, onSent, loadErr, initLoading, firstSeq, hasMore', {}, {
      route: { params: { sessionId: 'session' } },
      useNavigation: () => ({}), useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}),
      sessionCache: new Map(), pendingSessionMessages: new Map(), getSessionMode: () => 'default',
      api, fetchSessions: async () => {}, ws: { subscribe() {}, unsubscribe() {} },
      msgKey: (m) => `${m.seq}:${m.blockIndex || 0}`, cmpMsg: (a, b) => a.seq - b.seq || (a.blockIndex || 0) - (b.blockIndex || 0),
      applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys,
      toast() {}, setSessionMode() {}, PERMISSION_MODES: ['default'],
      haptics: { success() {} },
      newClientMessageId, reconcilePending, sendFailureState,
      ...dependencies,
    });
  instance.render();
  return instance;
}
const user = { seq: 1, role: 'user', kind: 'text', text: '问题' };
const answer = { seq: 2, blockIndex: 0, apiMessageId: 'msg', role: 'assistant', kind: 'text', text: '好的' };
const stream = { sessionId: 'session', key: 'msg:0', offset: 0, text: '好的', done: true };

test('actual ChatScreen: replies vibrate once on completion, without feedback for streaming, history, other sessions or stale runs', async () => {
  const feedback = [];
  const page = screen(async () => ({ messages: [user, answer], firstSeq: 1, hasMore: false }), {
    haptics: { success: () => feedback.push('success') },
  });
  page.effects();
  await new Promise(setImmediate);
  await page.emit('ws-open');
  page.emit('ws:run', { sessionId: 'other', state: 'done', runId: 'other' });
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'A' });
  page.emit('ws:stream', stream);
  page.emit('ws:message', { sessionId: 'session', message: answer });
  await new Promise(setImmediate);
  assert.deepEqual(feedback, []);
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'A' });
  page.render();
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'A' });
  assert.deepEqual(feedback, ['success']);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B' });
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'old' });
  page.emit('ws:run', { sessionId: 'session', state: 'error', runId: 'B', error: 'aborted' });
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'C' });
  page.emit('ws:run', { sessionId: 'session', state: 'error', runId: 'C', error: 'network_error' });
  assert.deepEqual(feedback, ['success']);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'D' });
  page.emit('ws:session-state', { sessionId: 'session', status: 'idle', activeRunId: null });
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'D' });
  assert.deepEqual(feedback, ['success', 'success'], 'idle snapshot may arrive before completion');
  page.unmount();
});

test('actual ChatScreen: HTTP reconnect, duplicate fetch and late stream snapshot reconcile', async () => {
  const page = screen(async () => ({ messages: [user, answer], firstSeq: 1, hasMore: false }));
  page.render().addMsgs([user]);
  page.emit('ws:stream', stream);
  assert.equal(page.render().drafts.length, 1);
  await page.emit('ws-open');
  assert.equal(page.render().drafts.length, 0);
  page.emit('ws:stream', stream);
  assert.equal(page.render().drafts.length, 0);
  await page.emit('ws-open');
  assert.equal(page.render().store.current.sorted.length, 2);
});

test('actual ChatScreen: old text, terminal events and cleanup cannot affect new run', () => {
  const page = screen();
  page.render().addMsgs([user, answer]);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B' });
  page.emit('ws:stream', { ...stream, key: 'new:0' });
  page.emit('ws:stream', { sessionId: 'session', clear: true });
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'C' });
  page.emit('ws:stream', { ...stream, key: 'next:0' });
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'B' });
  page.flushTimers();
  assert.equal(page.render().activeRunId, 'C');
  assert.deepEqual(page.render().drafts.map((d) => d.key), ['next:0']);
  page.emit('ws:session-state', { sessionId: 'session', activeRunId: null, status: 'terminal-driving' });
  assert.equal(page.render().drafts.length, 0);
  assert.equal(page.render().runActive, false);
  assert.equal(page.render().status, 'terminal-driving');
});

test('actual ChatScreen: resync invalidates an older HTTP response', async () => {
  let resolveOld;
  let calls = 0;
  const page = screen(() => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ messages: [user, answer], firstSeq: 1, hasMore: false }));
  const old = page.emit('ws-open');
  await page.emit('ws:resync', { sessionId: 'session' });
  resolveOld({ messages: [{ ...answer, seq: 50, text: '过期数据' }], firstSeq: 50, hasMore: false });
  await old;
  assert.deepEqual(page.render().store.current.sorted.map((m) => m.text), ['问题', '好的']);
});

function composer(api, callbacks = {}, deps = {}) {
  const initial = { sessionId: 'session', activeRunId: 'A', isRunning: true, status: 'daemon-driving', ...callbacks };
  const instance = mount(composerSource, 'export function ChatComposer({', '  const onContentSizeChange =',
    'stopRun, releaseSession, stopping, canSend, doSend, draft, setDraft, setFiles, pickModel, pickEffort, effort, modelOverride', initial, {
      useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}), useModelCatalog: () => ({}),
      useEffortLevels: () => ({ options: null, reload: () => {} }),
      getSessionModel: () => '', setSessionModel: () => {}, modelSelection: () => ({ status: 'default' }),
      fetchModels: async () => {},
      getSessionEffort, setSessionEffort, effortLabel, effortUsable,
      token: 'test-token', newClientMessageId, sendFailureState,
      api,
      uploadAttachments: async (files) => files, withAttachmentNote: (text) => text || '附件',
      haptics: { stop() {}, confirm() {}, tap() {}, selection() {}, success() {}, error() {} }, toast() {},
      ...deps,
    });
  // Preserve the actual destructuring header when executing this component body.
  return { instance, initial };
}

test('actual ChatComposer: stop accepted stays running until terminal props arrive', async () => {
  let stopped = 0;
  const { instance, initial } = composer(async () => ({ runId: 'A', status: 'aborted' }), { onStopped: () => stopped++ });
  instance.render(); instance.effects();
  await instance.render().stopRun();
  assert.equal(instance.render().stopping, true);
  assert.equal(instance.render().canSend, false);
  assert.equal(stopped, 0);
  instance.render({ ...initial, isRunning: false, activeRunId: null, status: 'idle' }); instance.effects();
  assert.equal(instance.render().stopping, false);
});

test('actual ChatComposer: stale success/mismatch and generic 409 never stop a newer run', async () => {
  for (const result of ['idle', 'run_mismatch', 'not_idle']) {
    let resolveRequest;
    let rejectRequest;
    let stopped = 0;
    let mismatches = 0;
    const { instance, initial } = composer(() => new Promise((resolve, reject) => {
      resolveRequest = resolve; rejectRequest = reject;
    }), { onStopped: () => stopped++, onRunMismatch: () => mismatches++ });
    instance.render(); instance.effects();
    const pending = instance.render().stopRun();
    instance.render({ ...initial, activeRunId: 'B' }); instance.effects();
    if (result === 'idle') resolveRequest({ runId: null, status: 'idle' });
    else rejectRequest({ status: 409, code: result, data: { activeRunId: 'old-B' } });
    await pending;
    assert.equal(stopped, 0);
    assert.equal(mismatches, 0);
  }
});

test('actual ChatComposer: mismatch syncs current run; generic failures keep run active', async () => {
  for (const code of ['run_mismatch', 'not_idle', 'not_found']) {
    let stopped = 0;
    const mismatches = [];
    const { instance } = composer(async () => { throw { status: code === 'not_found' ? 404 : 409, code, data: { activeRunId: 'B', status: 'daemon-driving' } }; }, {
      onStopped: () => stopped++, onRunMismatch: (...args) => mismatches.push(args),
    });
    instance.render(); instance.effects();
    await instance.render().stopRun();
    assert.equal(stopped, 0);
    assert.equal(instance.render().stopping, false);
    assert.deepEqual(mismatches, code === 'run_mismatch' ? [['B', 'daemon-driving']] : []);
  }
});

test('actual ChatComposer: ended run preserves terminal-driving from server', async () => {
  const statuses = [];
  let stopped = 0;
  const { instance } = composer(async () => ({ runId: null, status: 'idle', sessionStatus: 'terminal-driving' }), {
    onStopped: () => stopped++, onStatusConflict: (status) => statuses.push(status),
  });
  instance.render(); instance.effects();
  await instance.render().stopRun();
  assert.equal(stopped, 1);
  assert.deepEqual(statuses, ['terminal-driving']);
});

test('actual ChatScreen: reconnect snapshots recover ended runs and the current run even with no messages/list entry', async () => {
  for (const status of ['idle', 'terminal-driving']) {
    const page = screen();
    page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'A' });
    page.emit('ws:stream', stream);
    page.emit('ws:stream', { sessionId: 'session', clear: true });
    page.emit('ws-state', { phase: 'closed' });
    const recovering = page.emit('ws-open');
    page.emit('ws:session-state', { sessionId: 'session', status, activeRunId: null });
    await recovering;
    assert.equal(page.render().runActive, false);
    assert.equal(page.render().activeRunId, null);
    assert.equal(page.render().status, status);
    assert.deepEqual(page.render().drafts, []);
    page.emit('ws:session-state', { sessionId: 'session', status: 'daemon-driving', activeRunId: 'B' });
    page.emit('ws:stream', { ...stream, key: 'B:0' });
    page.flushTimers();
    assert.equal(page.render().activeRunId, 'B');
    assert.equal(page.render().runActive, true);
    assert.equal(page.render().drafts.length, 1);
  }
});

test('actual ChatScreen: old HTTP recovery cannot overwrite a new run or a newer connection', async () => {
  let resolveOld;
  let calls = 0;
  const cache = new Map([['session', { status: 'idle' }]]);
  const page = screen(() => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ messages: [user, answer], firstSeq: 1, hasMore: false }), { sessionCache: cache });
  const old = page.emit('ws-open');
  page.emit('ws-state', { phase: 'closed' });
  await page.emit('ws-open');
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B' });
  resolveOld({ messages: [{ ...answer, seq: 99, text: '过期恢复' }], firstSeq: 99, hasMore: false });
  await old;
  assert.equal(page.render().activeRunId, 'B');
  assert.equal(page.render().status, 'daemon-driving');
  assert.deepEqual(page.render().store.current.sorted.map((m) => m.text), ['问题', '好的']);
});

test('actual ChatScreen: failed initial loading is repaired by reconnect, including paging', async () => {
  let fail = true;
  const page = screen(async () => {
    if (fail) throw { code: 'network_error' };
    return { messages: [user, answer], firstSeq: 1, hasMore: true };
  });
  page.effects();
  await new Promise(setImmediate);
  assert.match(page.render().loadErr, /network_error/);
  fail = false;
  await page.emit('ws-open');
  assert.equal(page.render().loadErr, '');
  assert.equal(page.render().initLoading, false);
  assert.equal(page.render().firstSeq, 1);
  assert.equal(page.render().hasMore, true);
  page.unmount();
});

test('actual ChatScreen: send response supplies runId, but cannot revive an ended or superseded run', () => {
  const page = screen();
  const first = page.render().onSending('问题');
  page.render().onSent('问题', 'A', first);
  assert.equal(page.render().activeRunId, 'A');
  assert.equal(page.render().status, 'daemon-driving');
  assert.equal(page.render().runActive, true);
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'A' });
  const ended = page.render().onSending('下一条');
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B' });
  page.emit('ws:run', { sessionId: 'session', state: 'error', runId: 'B' });
  page.render().onSent('下一条', 'B', ended);
  assert.equal(page.render().activeRunId, null);
  assert.equal(page.render().runActive, false);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'C' });
  page.render().onSent('下一条', 'B', ended);
  assert.equal(page.render().activeRunId, 'C');
});

test('actual ChatComposer: text and attachment sends forward run identity and preserve omitted model', async () => {
  for (const attachmentOnly of [false, true]) {
    const sent = [];
    const context = { revision: 1 };
    const { instance, initial } = composer(async (_path, opts) => {
      assert.equal(Object.hasOwn(JSON.parse(opts.body), 'model'), false);
      return { runId: 'A' };
    }, { onSending: () => context, onSent: (...args) => sent.push(args) });
    const ready = { ...initial, status: 'idle', isRunning: false, activeRunId: null };
    instance.render(ready);
    if (attachmentOnly) instance.render().setFiles([{ name: 'file' }]);
    else instance.render().setDraft('问题');
    await instance.render().doSend();
    assert.deepEqual(sent, [[attachmentOnly ? '请查看我上传的附件。' : '问题', 'A', context]]);
  }
});

test('actual ChatScreen: a late list response on the same connection cannot reset a new run', async () => {
  let finishList;
  const cache = new Map();
  const page = screen(undefined, {
    sessionCache: cache,
    fetchSessions: () => new Promise((resolve) => { finishList = resolve; }),
  });
  const recovery = page.emit('ws-open');
  await new Promise(setImmediate);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B' });
  cache.set('session', { status: 'idle' });
  finishList();
  await recovery;
  assert.equal(page.render().status, 'daemon-driving');
  assert.equal(page.render().activeRunId, 'B');
});

test('actual ChatScreen: status before send response still permits binding its runId', () => {
  const page = screen();
  const context = page.render().onSending('问题');
  page.emit('ws:status', { sessionId: 'session', status: 'daemon-driving' });
  page.render().onSent('问题', 'A', context);
  assert.equal(page.render().activeRunId, 'A');
  assert.equal(page.render().runActive, true);
});

test('actual ChatComposer: forwards chosen effort, blocks it once the gateway says the model lacks it, and omits it when cleared', async () => {
  const sentBodies = [];
  const toasts = [];
  let options = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: true };
  const { instance, initial } = composer(
    async (_path, opts) => { sentBodies.push(JSON.parse(opts.body)); return { runId: 'run-effort' }; },
    { sessionId: 'sess-effort', status: 'idle', isRunning: false, activeRunId: null },
    {
      useEffortLevels: () => ({ options, reload: () => {} }),
      toast: (msg, type) => toasts.push({ msg, type }),
    },
  );
  instance.render(initial);
  instance.effects();

  instance.render().pickEffort('xhigh');
  instance.render().setDraft('深度分析');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].effort, 'xhigh');
  assert.equal(getSessionEffort('sess-effort'), 'xhigh');

  options = { levels: ['low', 'high', 'max'], verified: true };
  instance.render().setDraft('继续提问');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 1, 'unsupported effort must block send');
  assert.equal(instance.render().effort, 'xhigh', 'effort must not be silently downgraded');
  assert.equal(instance.render().draft, '继续提问');
  assert.match(toasts.at(-1).msg, /不支持思考程度「超高」/);

  options = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: false };
  await instance.render().doSend();
  assert.equal(sentBodies.length, 2, 'unverified levels must not block send');
  assert.equal(sentBodies[1].effort, 'xhigh');

  instance.render().pickEffort('');
  instance.render().setDraft('恢复默认');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 3);
  assert.equal(Object.hasOwn(sentBodies[2], 'effort'), false);
  assert.equal(getSessionEffort('sess-effort'), '');
});

test('actual NewChatComposer: sends effort on creation and stores it for the new session', async () => {
  const createdPayloads = [];
  const feedback = [];
  const newChat = mount(
    newComposerSource,
    'export function NewChatComposer({',
    '  const onContentSizeChange =',
    'create, setDraft, setModelChoice, setEffort, effort',
    {
      cwd: '/work/project',
      cwdLabel: 'project',
      cwdKnown: true,
      mode: 'default',
      onCreated: (res, body) => createdPayloads.push({ res, body }),
    },
    {
      haptics: { confirm: () => feedback.push('confirm'), error: () => feedback.push('error') },
      useTheme: () => ({ colors: {}, dark: false }),
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0 }),
      useModelCatalog: () => ({ models: [{ id: 'opus', alias: 'opus' }], loaded: true }),
      usePref: () => '',
      useEffortLevels: () => ({ options: { levels: ['low', 'high', 'max'], verified: true }, reload: () => {} }),
      modelSelection: () => ({ status: 'ok' }),
      effortLabel,
      effortUsable,
      setSessionMode: () => {},
      setSessionModel: () => {},
      setSessionEffort,
      createSession: async (args) => {
        assert.deepEqual(feedback, ['confirm'], 'first-message feedback must precede the creation response');
        return {
          result: { sessionId: 'sess-created-1', runId: 'r1' },
          body: { cwd: args.cwd, text: args.text, ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) },
        };
      },
      fetchModels: async () => {},
      tooLargeMessage: () => '',
      toast: () => {},
    },
  );

  newChat.render();
  newChat.effects();
  newChat.render().setModelChoice('opus');
  newChat.render().setEffort('max');
  newChat.render().setDraft('开始新任务');
  await newChat.render().create();

  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].body.effort, 'max');
  assert.equal(createdPayloads[0].body.model, 'opus');
  assert.equal(getSessionEffort('sess-created-1'), 'max');
  assert.equal(newChat.render().effort, '', 'draft effort resets after creation');
  assert.deepEqual(feedback, ['confirm'], 'creation success must not play a second effect');

  newChat.render().setEffort('medium');
  newChat.render().setDraft('第二个任务');
  await newChat.render().create();
  assert.equal(createdPayloads.length, 1, 'effort the gateway does not list must block creation');
  assert.deepEqual(feedback, ['confirm'], 'blocked creation must not play send feedback');
});

test('actual ChatComposer: send feedback is immediate, success is quiet, and only actionable failures vibrate', async () => {
  for (const code of [null, 'network_error', 'connection_changed', 'unauthorized']) {
    const feedback = [];
    let finishUpload;
    const { instance, initial } = composer(async () => {
      if (code) throw { code };
      return { runId: 'A' };
    }, {}, {
      haptics: {
        confirm: () => feedback.push('confirm'), success: () => feedback.push('success'), error: () => feedback.push('error'),
      },
      uploadAttachments: () => new Promise((resolve) => { finishUpload = resolve; }),
    });
    instance.render({ ...initial, status: 'idle', isRunning: false, activeRunId: null });
    instance.render().setDraft('问题');
    const sending = instance.render().doSend();
    assert.deepEqual(feedback, ['confirm'], 'feedback must precede attachment upload and HTTP response');
    finishUpload([]);
    await sending;
    assert.deepEqual(feedback, code === 'network_error' ? ['confirm', 'error'] : ['confirm']);
  }
});

test('actual ApprovalLayer: duplicate live events and pending sync notify once before rendering', async () => {
  const interaction = { interactionId: 'approval-A', expiresAt: Date.now() + 60000 };
  let reminders = 0;
  const layer = mount(approvalSource, 'export function ApprovalLayer() {', '  if (items.length === 0)',
    'items, syncPending', {}, {
      useTheme: () => ({ fonts: {} }), useSafeAreaInsets: () => ({}),
      api: async () => ({ interactions: [interaction] }),
      haptics: { attention: () => reminders++ }, toast() {},
    });
  layer.render();
  layer.emit('ws:approval', { interaction });
  layer.emit('ws:approval', { interaction });
  await layer.render().syncPending();
  assert.equal(reminders, 1);
  assert.equal(layer.render().items.length, 1);
  layer.emit('ws:approval.resolved', { interactionId: interaction.interactionId, status: 'allowed' });
  layer.flushTimers();
  layer.render();
  layer.emit('ws:approval', { interaction });
  assert.equal(reminders, 1, 'late replay after card removal must stay quiet');
  layer.emit('ws:approval', { interaction: { interactionId: 'expired', expiresAt: Date.now() - 1 } });
  assert.equal(reminders, 1, 'expired approvals must stay quiet');
  layer.emit('ws:approval', { interaction: { ...interaction, interactionId: 'approval-B' } });
  assert.equal(reminders, 2, 'a distinct approval must still be eligible for feedback');
});

test('actual ChatScreen: identical texts reconcile by UUID, echo before HTTP response stays confirmed', async () => {
  const page = screen();
  const first = page.render().onSending('问题', { clientMessageId: 'first' });
  page.render().onSending('问题', { clientMessageId: 'second' });
  page.emit('ws:message', { sessionId: 'session', message: { ...user, uuid: 'first' } });
  await new Promise(setImmediate);
  assert.deepEqual(page.render().pending.map((p) => p.clientMessageId), ['second']);
  page.render().onSent('问题', 'A', { ...first, precise: true });
  assert.deepEqual(page.render().pending.map((p) => p.clientMessageId), ['second']);
  page.render().addMsgs([{ ...user, seq: 2, uuid: 'second' }]);
  assert.deepEqual(page.render().pending, []);
});

test('actual ChatScreen: lost response retains unknown state and reconnect confirms from history; definite failure stays retryable', async () => {
  const page = screen(async () => ({ messages: [{ ...user, uuid: 'lost' }], firstSeq: 1, hasMore: false }));
  const context = page.render().onSending('问题', { clientMessageId: 'lost', retry() {} });
  page.render().onSendFailed({ status: 0, code: 'network_error' }, context, true);
  assert.equal(page.render().pending[0].state, 'unconfirmed');
  await new Promise(setImmediate);
  assert.deepEqual(page.render().pending, []);
  const rejected = page.render().onSending('另一条', { clientMessageId: 'rejected', retry() {} });
  page.render().onSendFailed({ status: 409 }, rejected, true);
  assert.equal(page.render().pending[0].state, 'failed');
  assert.equal(typeof page.render().pending[0].retry, 'function');
});

test('actual ChatScreen: replayed response confirms delivery without reviving a completed run', () => {
  const page = screen();
  const context = page.render().onSending('问题', { clientMessageId: 'old' });
  page.render().onSent('问题', 'completed', { ...context, precise: true, replayed: true });
  assert.equal(page.render().runActive, false);
  assert.equal(page.render().activeRunId, null);
});

test('actual ChatComposer: retry reuses original UUID, text and uploaded attachment body', async () => {
  let retry;
  let uploads = 0;
  const bodies = [];
  const failed = [];
  const { instance, initial } = composer(async (_path, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) throw { status: 0, code: 'network_error' };
    return { runId: 'A', clientMessageId: bodies[0].clientMessageId };
  }, { onSending: (_text, item) => { retry = item.retry; return {}; }, onSendFailed: (...args) => failed.push(args) }, {
    uploadAttachments: async () => { uploads++; return ['/uploaded/picture.png']; },
    withAttachmentNote: (text, files) => `${text}\n${files.join('\n')}`,
  });
  instance.render({ ...initial, status: 'idle', isRunning: false, activeRunId: null });
  instance.render().setDraft('原文');
  instance.render().setFiles([{ uri: 'file:///fixture' }]);
  await instance.render().doSend();
  assert.equal(instance.render().draft, '');
  assert.equal(failed[0][2], true);
  instance.render().setDraft('新的草稿');
  await retry();
  assert.equal(uploads, 1);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(instance.render().draft, '新的草稿');
});
