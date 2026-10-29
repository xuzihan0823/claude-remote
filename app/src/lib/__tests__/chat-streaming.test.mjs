import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys } from '../../../../web/core/stream-drafts.js';

const storageValues = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  };
}
const {
  EMPTY_CAPABILITIES,
  effortSelection,
  getSessionEffort,
  normalizeCapabilities,
  resolveDeviceKey,
  setSessionEffort,
  syncSessionEffortRevision,
} = await import('../../../../web/core/effort.js');
const screenSource = readFileSync(new URL('../../screens/ChatScreen.js', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../../components/composer/ChatComposer.js', import.meta.url), 'utf8');
const newComposerSource = readFileSync(new URL('../../components/composer/NewChatComposer.js', import.meta.url), 'utf8');
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
    'drafts, store, runActive, activeRunId, status, addMsgs, onSending, onSent, loadErr, initLoading, firstSeq, hasMore', {}, {
      route: { params: { sessionId: 'session' } },
      useNavigation: () => ({}), useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}),
      sessionCache: new Map(), pendingSessionMessages: new Map(), getSessionMode: () => 'default',
      api, fetchSessions: async () => {}, ws: { subscribe() {}, unsubscribe() {} },
      msgKey: (m) => `${m.seq}:${m.blockIndex || 0}`, cmpMsg: (a, b) => a.seq - b.seq || (a.blockIndex || 0) - (b.blockIndex || 0),
      applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys,
      toast() {}, setSessionMode() {}, PERMISSION_MODES: ['default'],
      isEcho: () => false, pendingText: (p) => p.text,
      ...dependencies,
    });
  instance.render();
  return instance;
}
const user = { seq: 1, role: 'user', kind: 'text', text: '问题' };
const answer = { seq: 2, blockIndex: 0, apiMessageId: 'msg', role: 'assistant', kind: 'text', text: '好的' };
const stream = { sessionId: 'session', key: 'msg:0', offset: 0, text: '好的', done: true };

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
    'stopRun, releaseSession, stopping, canSend, doSend, draft, setDraft, setFiles, pickModel, pickEffort, effortRecord, modelOverride', initial, {
      useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}), useModelCatalog: () => ({}),
      useModelCapabilities: () => ({ capabilities: EMPTY_CAPABILITIES, reload: () => {}, applyServerCapabilities: () => {} }),
      getSessionModel: () => '', setSessionModel: () => {}, modelSelection: () => ({ status: 'default' }),
      fetchModels: async () => {},
      getSessionEffort: () => ({ effort: '', model: '', revision: '', deviceId: 'default', stale: false }),
      setSessionEffort: (_sid, rec) => ({ effort: rec.effort || '', model: rec.model || '', revision: rec.revision || '', deviceId: 'default', stale: false }),
      syncSessionEffortRevision: (_sid, _caps) => ({ effort: '', model: '', revision: '', deviceId: 'default', stale: false }),
      effortSelection,
      resolveDeviceKey,
      api,
      uploadAttachments: async (files) => files, withAttachmentNote: (text) => text || '附件',
      haptics: { reject() {}, success() {}, error() {} }, toast() {},
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
    assert.deepEqual(sent, [[attachmentOnly ? '附件' : '问题', 'A', context]]);
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

test('actual ChatComposer: forwards selected effort, blocks unsupported/stale effort without silent downgrade, and refreshes on 400 unsupported_effort', async () => {
  const sentBodies = [];
  const toasts = [];
  const appliedCaps = [];
  let currentCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    revision: 'rev-1',
    thinkingEnabled: true,
  });
  const { instance, initial } = composer(
    async (_path, opts) => {
      const parsed = JSON.parse(opts.body);
      if (parsed.effort === 'xhigh' && currentCaps.status === 'known' && !currentCaps.effortLevels.includes('xhigh')) {
        throw { status: 400, code: 'unsupported_effort', data: { capabilities: currentCaps } };
      }
      sentBodies.push(parsed);
      return { runId: 'run-effort' };
    },
    { status: 'idle', isRunning: false, activeRunId: null },
    {
      useModelCapabilities: () => ({
        capabilities: currentCaps,
        reload: async () => currentCaps,
        applyServerCapabilities: (c) => appliedCaps.push(c),
      }),
      toast: (msg, type) => toasts.push({ msg, type }),
    },
  );

  instance.render(initial);
  instance.effects();

  // 1. Pick 'xhigh' under rev-1 and send -> effort is forwarded in body
  instance.render().pickEffort('xhigh');
  instance.render().setDraft('深度分析');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].effort, 'xhigh');

  // 2. Switch model to one where 'xhigh' is NOT in effortLevels -> selection is kept ('xhigh'), NOT downgraded, and send is blocked
  instance.render().pickModel('haiku');
  currentCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium'],
    revision: 'rev-1',
    thinkingEnabled: true,
  });
  instance.render().setDraft('继续提问');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 1, 'send must be blocked when chosen effort is unsupported by new model');
  assert.equal(instance.render().effortRecord.effort, 'xhigh', 'old effort must not be silently downgraded');
  assert.match(toasts.at(-1).msg, /不支持「超高」/);

  // 3. Revision drift marks selection stale and blocks send until user re-selects or clears
  currentCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    revision: 'rev-2-changed',
    thinkingEnabled: true,
  });
  await instance.render().doSend();
  assert.equal(sentBodies.length, 1, 'send must be blocked when revision changed');
  assert.match(toasts.at(-1).msg, /配置已变化/);

  // 4. Clearing effort ('') restores default and omits effort field from request body
  instance.render().pickEffort('');
  await instance.render().doSend();
  assert.equal(sentBodies.length, 2);
  assert.equal(Object.hasOwn(sentBodies[1], 'effort'), false);
});

test('actual NewChatComposer: persists effort with model and revision on creation and ChatComposer restores it across session switches', async () => {
  const createdPayloads = [];
  const currentCaps = normalizeCapabilities({
    status: 'known',
    effortLevels: ['low', 'medium', 'high', 'max'],
    revision: 'rev-new-chat',
    thinkingEnabled: true,
  });

  const newChat = mount(
    newComposerSource,
    'export function NewChatComposer({',
    '  const onContentSizeChange =',
    'create, setDraft, setModelChoice, pickEffort, effortRecord',
    {
      cwd: '/work/project',
      cwdLabel: 'project',
      cwdKnown: true,
      mode: 'default',
      onCreated: (res, body) => createdPayloads.push({ res, body }),
    },
    {
      useTheme: () => ({ colors: {}, dark: false }),
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0 }),
      useModelCatalog: () => ({ models: [{ id: 'opus', alias: 'opus' }], loaded: true }),
      usePref: () => '',
      useModelCapabilities: () => ({
        capabilities: currentCaps,
        reload: async () => currentCaps,
        applyServerCapabilities: () => {},
      }),
      modelSelection: () => ({ status: 'ok' }),
      effortSelection,
      resolveDeviceKey,
      setSessionMode: () => {},
      setSessionModel: () => {},
      setSessionEffort,
      createSession: async (args) => ({
        result: { sessionId: 'sess-created-1', runId: 'r1' },
        body: { cwd: args.cwd, text: args.text, ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) },
      }),
      fetchModels: async () => {},
      tooLargeMessage: () => '',
      toast: () => {},
    },
  );

  newChat.render();
  newChat.effects();
  newChat.render().setModelChoice('opus');
  newChat.render().pickEffort('max');
  newChat.render().setDraft('开始新任务');
  await newChat.render().create();

  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].body.effort, 'max');
  assert.equal(createdPayloads[0].body.model, 'opus');

  // Stored session effort includes model and revision, and survives switching sessions
  const stored = getSessionEffort('sess-created-1');
  assert.equal(stored.effort, 'max');
  assert.equal(stored.model, 'opus');
  assert.equal(stored.revision, 'rev-new-chat');

  setSessionEffort('sess-other', { effort: 'low', model: 'sonnet', revision: 'rev-other' });
  assert.equal(getSessionEffort('sess-other').effort, 'low');
  assert.equal(getSessionEffort('sess-created-1').effort, 'max');
});

test('ChatComposer refreshes explicit effort before sending and preserves draft when config changes', async () => {
  let sent = 0;
  const before = normalizeCapabilities({ status: 'known', effortLevels: ['high'], revision: 'old' });
  const after = normalizeCapabilities({ status: 'known', effortLevels: ['high'], revision: 'new' });
  const notices = [];
  const { instance, initial } = composer(async () => { sent++; return {}; }, { status: 'idle', isRunning: false, activeRunId: null }, {
    useModelCapabilities: () => ({ capabilities: before, reload: async () => after, applyServerCapabilities: () => {} }),
    toast: (message) => notices.push(message),
  });
  instance.render(initial);
  instance.effects();
  instance.render().pickEffort('high');
  instance.render().setDraft('keep this draft');
  await instance.render().doSend();
  assert.equal(sent, 0);
  assert.match(notices.at(-1), /配置已变化/);
  assert.equal(instance.render().effortRecord.effort, 'high');
  assert.equal(instance.render().draft, 'keep this draft');
});
