import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys } from '../../../../web/core/stream-drafts.js';

const screenSource = readFileSync(new URL('../../screens/ChatScreen.js', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../../components/composer/ChatComposer.js', import.meta.url), 'utf8');

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

function composer(api, callbacks = {}) {
  const initial = { sessionId: 'session', activeRunId: 'A', isRunning: true, status: 'daemon-driving', ...callbacks };
  const instance = mount(composerSource, 'export function ChatComposer({', '  const onContentSizeChange =',
    'stopRun, releaseSession, stopping, canSend, doSend, setDraft, setFiles', initial, {
      useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}), useModelCatalog: () => ({}),
      getSessionModel: () => '', modelSelection: () => ({ status: 'default' }), api,
      uploadAttachments: async (files) => files, withAttachmentNote: (text) => text || '附件',
      haptics: { reject() {}, success() {}, error() {} }, toast() {},
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
