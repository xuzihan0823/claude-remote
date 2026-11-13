import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys } from '../../../../web/core/stream-drafts.js';
import { newClientMessageId, reconcilePending, sendFailureState } from '../../../../web/core/message-delivery.js';
import { emptyPermissionState, reducePermissionState } from '../../../../web/core/permission-state.js';
import { isToolMessage, matchesMessageKey, mergeToolMessages, takeToolCard, toolScopeKey, TOOL_REVEAL_INTERVAL_MS } from '../tool-view.js';

const storageValues = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  };
}
const { effortLabel, effortUsable, getSessionEffort, setSessionEffort } = await import('../../../../web/core/effort.js');
const { runErrMsg, scopeErrMsg } = await import('../../../../web/core/api.js');
const screenSource = readFileSync(new URL('../../screens/ChatScreen.js', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../../components/composer/ChatComposer.js', import.meta.url), 'utf8');
const newComposerSource = readFileSync(new URL('../../components/composer/NewChatComposer.js', import.meta.url), 'utf8');
const approvalSource = readFileSync(new URL('../../components/ApprovalLayer.js', import.meta.url), 'utf8');
// 测试里 t() 只做参数插值、不翻译，断言仍按中文模板校验。
const fakeT = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k]))) : text);
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
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        effects[index] = { fn, deps, cleanup: previous?.cleanup, pending: true };
      }
    },
    useBus(name, handler) { handlers.set(name, handler); },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
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
  const compiled = transformSync(`${header}${body}`, { loader: 'jsx', jsxFactory: 'createElement' }).code;
  const run = new Function('props', ...Object.keys(hooks), `${compiled}\nreturn { ${exposed} };`);
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
    flushTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (!timers.has(id) || (delay != null && timer.delay !== delay)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    unmount() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

function screen(api = async () => ({ messages: [], firstSeq: null, hasMore: false }), dependencies = {}, includeScroll = false) {
  const scrollExports = includeScroll ? ', readingHistory, showJump, userScrolling, listRef, renderScroll, onScroll, onUserScrollBegin, onUserScrollEnd, onMomentumScrollEnd, jumpToBottom, onContentInsetChange, setFocusTarget' : '';
  const instance = mount(screenSource, 'export function ChatScreen({ route }) {', includeScroll ? '  const visiblePending =' : '  const kbOffset =',
    `pending, onSendFailed, drafts, store, toolArrival, runActive, activeRunId, status, addMsgs, onSending, onSent, loadErr, initLoading, firstSeq, hasMore, loadOlder, permissionState, mode, setMode${scrollExports}`, {}, {
      route: { params: { sessionId: 'session' } },
      useNavigation: () => ({}), useTheme: () => ({ colors: {} }), useSafeAreaInsets: () => ({}),
      useI18n: () => ({ t: fakeT }),
      sessionCache: new Map(), pendingSessionMessages: new Map(), getSessionMode: () => 'default',
      api, fetchSessions: async () => {}, ws: { subscribe() {}, unsubscribe() {} },
      msgKey: (m) => `${m.seq}:${m.blockIndex || 0}`, cmpMsg: (a, b) => a.seq - b.seq || (a.blockIndex || 0) - (b.blockIndex || 0),
      applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys,
      emptyPermissionState, reducePermissionState,
      toast() {}, setSessionMode() {}, PERMISSION_MODES: ['default'],
      haptics: { success() {} },
      newClientMessageId, reconcilePending, sendFailureState, runErrMsg, scopeErrMsg,
      mergePermissionDenials: (messages) => ({ messages, unmatched: [] }),
      MVCP_READING: { minIndexForVisible: 0 },
      KeyboardChatScrollView: 'KeyboardChatScrollView',
      createElement: (type, props) => ({ type, props }),
      isToolMessage, matchesMessageKey, mergeToolMessages, takeToolCard, toolScopeKey, TOOL_REVEAL_INTERVAL_MS,
      ...dependencies,
    });
  instance.render();
  return instance;
}
const user = { seq: 1, role: 'user', kind: 'text', text: '问题' };
const answer = { seq: 2, blockIndex: 0, apiMessageId: 'msg', role: 'assistant', kind: 'text', text: '好的' };
const stream = { sessionId: 'session', key: 'msg:0', offset: 0, text: '好的', done: true };

const scrollEvent = (y, velocity = 0) => ({ nativeEvent: { contentOffset: { y }, velocity: { y: velocity } } });
const nativeScrollProps = (page) => {
  const state = page.render();
  return state.renderScroll({ maintainVisibleContentPosition: state.readingHistory ? { minIndexForVisible: 1 } : undefined }).props;
};

test('actual ChatScreen: native position maintenance stays enabled and uses the bottom header only while following', () => {
  const page = screen(undefined, {}, true);
  assert.match(screenSource, /maintainVisibleContentPosition=\{readingHistory \? MVCP_READING : undefined\}/, 'FlatList must not wait for a native offset correction while the header anchors the bottom');
  assert.deepEqual(nativeScrollProps(page).maintainVisibleContentPosition, { minIndexForVisible: 0 });
  page.render().onUserScrollBegin(scrollEvent(0));
  page.render().onScroll(scrollEvent(4));
  assert.equal(page.render().readingHistory, true, 'even a short drag anchors the messages');
  assert.deepEqual(nativeScrollProps(page).maintainVisibleContentPosition, { minIndexForVisible: 1 });
  page.render().onUserScrollEnd(scrollEvent(12));
  page.render().onScroll(scrollEvent(0));
  assert.equal(page.render().readingHistory, true, 'native compensation cannot resume following');
  page.render().onUserScrollBegin(scrollEvent(0));
  assert.equal(page.render().readingHistory, false);
  assert.deepEqual(nativeScrollProps(page).maintainVisibleContentPosition, { minIndexForVisible: 0 });
});

test('actual ChatScreen: keyboard offsets, drag momentum and an explicit jump preserve scrolling intent', () => {
  const page = screen(undefined, {}, true);
  const offsets = [];
  page.render().listRef.current = { scrollToOffset: (value) => offsets.push(value) };
  page.render().onContentInsetChange({ top: 280 });
  page.render().onScroll(scrollEvent(-100));
  assert.equal(page.render().readingHistory, false, 'programmatic keyboard movement does not detach');
  page.render().onUserScrollBegin(scrollEvent(-280));
  page.render().onScroll(scrollEvent(-250));
  page.render().onUserScrollEnd(scrollEvent(-200, -1));
  assert.equal(page.render().readingHistory, true);
  page.render().onScroll(scrollEvent(-279));
  page.render().onMomentumScrollEnd(scrollEvent(-280));
  assert.equal(page.render().readingHistory, false, 'momentum reaching the inset-adjusted bottom resumes following');
  assert.equal(page.render().userScrolling.current, false);
  page.render().onUserScrollBegin(scrollEvent(20));
  assert.equal(page.render().showJump, true);
  page.render().jumpToBottom();
  page.render().onScroll(scrollEvent(-100));
  assert.equal(page.render().readingHistory, false, 'intermediate jump offsets cannot detach again');
  assert.equal(page.render().showJump, false);
  assert.deepEqual(offsets, [{ offset: -280, animated: true }]);
});

test('actual ChatScreen: incoming text and tools cannot change reading intent; a fresh session resets it', async () => {
  const page = screen(undefined, {}, true);
  page.effects();
  await new Promise(setImmediate);
  page.render().onUserScrollBegin(scrollEvent(320));
  page.render().onUserScrollEnd(scrollEvent(320));
  page.emit('ws:stream', stream);
  page.emit('ws:message', { sessionId: 'session', message: answer });
  page.emit('ws:message', { sessionId: 'session', message: { seq: 3, kind: 'tool_result', text: '完成' } });
  await new Promise(setImmediate);
  assert.equal(page.render().drafts.length, 0);
  page.render().onScroll(scrollEvent(50));
  assert.equal(page.render().readingHistory, true);
  assert.deepEqual(nativeScrollProps(page).maintainVisibleContentPosition, { minIndexForVisible: 1 });
  page.render().onUserScrollBegin(scrollEvent(0));
  page.emit('ws:stream', { ...stream, key: 'next:0' });
  assert.equal(page.render().readingHistory, false);
  page.render().onUserScrollBegin(scrollEvent(320));
  page.unmount();
  const fresh = screen(undefined, {}, true);
  fresh.effects();
  assert.equal(fresh.render().readingHistory, false);
  assert.equal(fresh.render().showJump, false);
  assert.equal(fresh.render().userScrolling.current, false);
  fresh.unmount();
});

test('actual ChatScreen: search positioning explicitly enters history reading without requiring a drag', () => {
  const page = screen(undefined, {}, true);
  page.effects();
  page.render().addMsgs([answer]);
  page.render().setFocusTarget({ key: '2:0', nonce: 1 });
  page.render();
  page.effects();
  assert.equal(page.render().readingHistory, true);
  assert.deepEqual(nativeScrollProps(page).maintainVisibleContentPosition, { minIndexForVisible: 1 });
  page.unmount();
});

// Mirror iOS prepare/adjust around a mounting transaction, using the actual scroll props.
function nativePositionModel(page, headerHeight = 0) {
  const header = { y: 16, height: headerHeight };
  const history = { y: 16 + headerHeight, height: 800 };
  const views = [header, history];
  let position = nativeScrollProps(page).maintainVisibleContentPosition;
  const model = {
    header, history, views, offset: 0,
    commit(update = () => {}) {
      assert.ok(position, 'position maintenance is enabled before every mount');
      const candidates = views.slice(position.minIndexForVisible);
      const anchor = candidates.find((view) => view.y + view.height > model.offset) || candidates.at(-1);
      const anchorY = anchor.y;
      update();
      let y = 16;
      for (const view of views) {
        view.y = y;
        y += view.height;
      }
      position = nativeScrollProps(page).maintainVisibleContentPosition;
      assert.ok(position, 'position maintenance is enabled after every mount');
      const delta = anchor.y - anchorY;
      if (Math.abs(delta) > 0.5) model.offset += delta;
    },
  };
  return model;
}

test('native anchor regression: bottom stays fixed through pending bubbles, tool insertion and draft growth', () => {
  const page = screen(undefined, {}, true);
  const model = nativePositionModel(page);
  model.commit(() => { model.header.height = 80; });
  assert.equal(model.offset, 0);
  model.commit(() => {
    model.header.height = 0;
    model.views.splice(1, 0, { y: 0, height: 80 });
  });
  assert.equal(model.offset, 0, 'pending-to-saved transition does not push the list off the bottom');
  model.commit(() => { model.views.splice(1, 0, { y: 0, height: 64 }); });
  model.commit(() => { model.header.height = 600; });
  assert.equal(model.offset, 0, 'tools and streaming text follow the bottom without a scroll animation');
});

test('native anchor regression: reading a long draft survives growth, conversion and tools, including repeated bottom visits', () => {
  const page = screen(undefined, {}, true);
  const model = nativePositionModel(page, 900);
  for (let cycle = 0; cycle < 3; cycle++) {
    model.offset = 240;
    page.render().onUserScrollBegin(scrollEvent(model.offset));
    page.render().onUserScrollEnd(scrollEvent(model.offset));
    model.commit();
    const historyPosition = model.history.y - model.offset;
    const paragraphPosition = model.header.y + model.header.height - 100 - model.offset;
    model.commit(() => { model.header.height += 120; });
    assert.equal(model.history.y - model.offset, historyPosition);
    assert.equal(model.header.y + model.header.height - 100 - model.offset, paragraphPosition);
    const saved = { y: 0, height: model.header.height + 56 };
    model.commit(() => {
      model.header.height = 0;
      model.views.splice(1, 0, saved);
    });
    assert.equal(model.history.y - model.offset, historyPosition);
    assert.equal(saved.y + saved.height - 100 - model.offset, paragraphPosition, 'the paragraph stays in place when saved actions add height');
    const savedPosition = saved.y - model.offset;
    model.commit(() => { model.views.splice(1, 0, { y: 0, height: 64 }); });
    assert.equal(saved.y - model.offset, savedPosition);
    page.render().jumpToBottom();
    model.offset = 0;
    model.commit();
    model.commit(() => { model.header.height = 900; });
    assert.equal(model.offset, 0, 'a later draft follows the bottom without reusing a history anchor');
  }
});

test('tool cards keep opacity-only entry without layout animation that disagrees with native anchoring', () => {
  const source = readFileSync(new URL('../../components/MessageRow.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('function Block('), source.indexOf('function MonoBody('));
  const entry = block.slice(block.indexOf('  const enterStyle ='), block.indexOf('  const chevronStyle ='));
  assert.match(entry, /opacity:/);
  assert.doesNotMatch(entry, /transform|translate|scale/);
  assert.doesNotMatch(block, /layout=|LinearTransition/);
});

test('actual ChatScreen: replies vibrate once on completion, without feedback for streaming, history, other sessions or stale runs', async () => {
  const feedback = [];
  const toasts = [];
  const page = screen(async () => ({ messages: [user, answer], firstSeq: 1, hasMore: false }), {
    haptics: { success: () => feedback.push('success') },
    toast: (msg, kind) => toasts.push([msg, kind]),
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
  assert.deepEqual(toasts, []);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'C' });
  page.emit('ws:run', { sessionId: 'session', state: 'error', runId: 'C', error: 'network_error' });
  assert.deepEqual(toasts, [['模型运行：连接中断', 'error']]);
  assert.deepEqual(feedback, ['success']);
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
      useI18n: () => ({ t: fakeT }),
      getSessionModel: () => '', setSessionModel: () => {}, modelSelection: () => ({ status: 'default' }),
      fetchModels: async () => {},
      getSessionEffort, setSessionEffort, effortLabel, effortUsable,
      token: 'test-token', newClientMessageId, sendFailureState, scopeErrMsg,
      api,
      uploadAttachments: async (files) => files, withAttachmentNote: (text) => text || '附件',
      haptics: { stop() {}, confirm() {}, tap() {}, selection() {}, success() {}, error() {} }, toast() {},
      ...deps,
    });
  // Preserve the actual destructuring header when executing this component body.
  return { instance, initial };
}

test('actual ChatComposer: terminal_alive keeps the session locked and explains how to exit', async () => {
  const events = [];
  const statuses = [];
  let stopped = 0;
  const { instance } = composer(async () => {
    throw { status: 409, code: 'terminal_alive', data: { status: 'terminal-driving' } };
  }, {
    activeRunId: null, isRunning: false, status: 'terminal-driving',
    onStopped: () => stopped++, onStatusConflict: (status) => statuses.push(status),
  }, {
    haptics: { error: () => events.push('error') },
    toast: (...args) => events.push(args),
  });
  instance.render(); instance.effects();
  await instance.render().releaseSession();
  assert.equal(stopped, 0);
  assert.equal(instance.render().canSend, false);
  assert.deepEqual(statuses, ['terminal-driving']);
  assert.deepEqual(events, ['error', ['解除占用：请先在终端输入 /exit', 'error']]);
});

test('actual ChatComposer: a stale release rejection cannot affect another session', async () => {
  let reject;
  const events = [];
  const { instance, initial } = composer(() => new Promise((_, fail) => { reject = fail; }), {
    activeRunId: null, isRunning: false, status: 'terminal-driving', onStatusConflict: () => events.push('status'),
  }, { haptics: { error: () => events.push('error') }, toast: () => events.push('toast') });
  instance.render(); instance.effects();
  const pending = instance.render().releaseSession();
  instance.render({ ...initial, sessionId: 'another-session' }); instance.effects();
  reject({ code: 'terminal_alive' });
  await pending;
  assert.deepEqual(events, []);
});

test('actual ChatComposer: release conflict syncs the new run without clearing it', async () => {
  const mismatches = [];
  let stopped = 0;
  const { instance } = composer(async () => {
    throw { code: 'run_mismatch', data: { activeRunId: 'B', status: 'daemon-driving' } };
  }, {
    activeRunId: null, isRunning: false, status: 'terminal-driving',
    onStopped: () => stopped++, onRunMismatch: (...args) => mismatches.push(args),
  });
  instance.render(); instance.effects();
  await instance.render().releaseSession();
  assert.equal(stopped, 0);
  assert.deepEqual(mismatches, [['B', 'daemon-driving']]);
});

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

test('actual ChatScreen: successful recovery supersedes late initial failures and paging metadata', async () => {
  for (const lateFailure of [true, false]) {
    let finishInitial;
    let rejectInitial;
    let calls = 0;
    const toasts = [];
    const page = screen(() => ++calls === 1
      ? new Promise((resolve, reject) => { finishInitial = resolve; rejectInitial = reject; })
      : Promise.resolve({ messages: [user, answer], firstSeq: 1, hasMore: true }), {
      toast: (msg) => toasts.push(msg),
    });
    page.effects();
    await page.emit('ws-open');
    if (lateFailure) rejectInitial({ code: 'network_error' });
    else finishInitial({ messages: [], firstSeq: null, hasMore: false });
    await new Promise(setImmediate);
    const state = page.render();
    assert.equal(state.loadErr, '');
    assert.equal(state.initLoading, false);
    assert.equal(state.firstSeq, 1);
    assert.equal(state.hasMore, true);
    assert.equal(state.store.current.sorted.length, 2);
    assert.deepEqual(toasts, []);
    page.unmount();
  }
});

test('actual ChatScreen: failed initial loading is repaired by reconnect, including paging', async () => {
  let fail = true;
  const toasts = [];
  const page = screen(async () => {
    if (fail) throw { code: 'network_error' };
    return { messages: [user, answer], firstSeq: 1, hasMore: true };
  }, {
    toast: (msg, kind) => toasts.push({ msg, kind }),
  });
  page.effects();
  await new Promise(setImmediate);
  assert.equal(page.render().loadErr, '会话加载：网络不可达');
  assert.deepEqual(toasts, [{ msg: '会话加载：网络不可达', kind: 'error' }]);
  fail = false;
  await page.emit('ws-open');
  assert.equal(page.render().loadErr, '');
  assert.equal(page.render().initLoading, false);
  assert.equal(page.render().firstSeq, 1);
  assert.equal(page.render().hasMore, true);
  fail = true;
  await page.render().loadOlder();
  assert.deepEqual(toasts.at(-1), { msg: '历史消息：网络不可达', kind: 'error' });
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
      usePref: () => '', token: 'test-token',
      useI18n: () => ({ t: fakeT }),
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
      scopeErrMsg,
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
      useI18n: () => ({ t: fakeT }),
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

test('actual ChatScreen: old daemon response enables text matching for an echo that arrived first', () => {
  const page = screen();
  const context = page.render().onSending('问题', { clientMessageId: 'new-client' });
  page.render().addMsgs([{ ...user, uuid: 'old-daemon-generated' }]);
  assert.equal(page.render().pending.length, 1);
  page.render().onSent('问题', 'A', { ...context, precise: false });
  assert.deepEqual(page.render().pending, []);
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
  instance.render({ ...initial, mode: 'auto', status: 'idle', isRunning: false, activeRunId: null });
  instance.render().setDraft('原文');
  instance.render().setFiles([{ uri: 'file:///fixture' }]);
  await instance.render().doSend();
  assert.equal(instance.render().draft, '');
  assert.equal(failed[0][2], true);
  instance.render().setDraft('新的草稿');
  await retry();
  assert.equal(uploads, 1);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[1].permissionMode, 'auto');
  assert.equal(instance.render().draft, '新的草稿');
});

test('actual ChatScreen: SDK downgrade and reconnect do not overwrite next-turn intent; stale facts stay ignored', () => {
  const writes = [];
  const page = screen(undefined, { getSessionMode: () => 'auto', setSessionMode: (...args) => writes.push(args) });
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'A', permissionMode: 'auto' });
  assert.equal(page.render().permissionState.effectiveMode, null);
  page.render().setMode('plan');
  page.emit('ws:permission-mode', { sessionId: 'session', runId: 'A', requestedMode: 'auto', effectiveMode: 'default' });
  assert.equal(page.render().mode, 'plan');
  assert.equal(page.render().permissionState.effectiveMode, 'default');
  page.emit('ws:permission-denied', { sessionId: 'session', runId: 'A', eventId: 'denied', toolUseId: 'tu', message: 'Denied' });
  page.emit('ws:permission-denied', { sessionId: 'session', runId: 'A', eventId: 'denied', toolUseId: 'tu', message: 'Denied' });
  assert.equal(page.render().permissionState.denials.length, 1);
  page.emit('ws:session-state', { sessionId: 'session', status: 'daemon-driving', activeRunId: 'A', requestedPermissionMode: 'auto', effectivePermissionMode: 'default' });
  assert.equal(page.render().permissionState.denials.length, 1);
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'B', permissionMode: 'auto' });
  page.emit('ws:permission-mode', { sessionId: 'session', runId: 'A', effectiveMode: 'bypassPermissions' });
  page.emit('ws:run', { sessionId: 'session', runId: 'A', state: 'started', permissionMode: 'bypassPermissions' });
  page.emit('ws:agent-notice', { sessionId: 'other', runId: 'B', eventId: 'notice', message: 'Wrong session' });
  assert.equal(page.render().activeRunId, 'B');
  assert.equal(page.render().permissionState.effectiveMode, null);
  assert.equal(page.render().permissionState.notices.length, 0);
  assert.equal(page.render().mode, 'plan');
  assert.deepEqual(writes, []);
});

function sendToolBurst(page, count, { results = false, startSeq = 1 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const toolUseId = `t${i + 1}`;
    const seq = startSeq + i * 2;
    page.emit('ws:message', { sessionId: 'session', message: { seq, kind: 'tool_use', toolUseId, toolName: 'Read' } });
    if (results) {
      page.emit('ws:message', { sessionId: 'session', message: { seq: seq + 1, kind: 'tool_result', toolUseId, text: `out-${i + 1}` } });
    }
  }
}

test('actual ChatScreen: fast tool bursts reveal one card per tick, including after streaming and run completion', () => {
  const page = screen();
  page.emit('ws:run', { sessionId: 'session', state: 'started', runId: 'A' });
  sendToolBurst(page, 20, { results: true, startSeq: 3 });
  page.emit('ws:stream', stream);
  assert.deepEqual(page.render().drafts.map((d) => d.text), [stream.text]);
  const saved = { ...answer, seq: 43 };
  page.emit('ws:message', { sessionId: 'session', message: saved });
  page.emit('ws:session-state', { sessionId: 'session', status: 'idle', activeRunId: null });
  page.emit('ws:run', { sessionId: 'session', state: 'done', runId: 'A' });
  assert.deepEqual(page.render().store.current.sorted, [saved]);
  assert.equal(page.render().drafts.length, 0);

  for (let i = 1; i <= 20; i += 1) {
    page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
    const { store, toolArrival } = page.render();
    const visible = mergeToolMessages(store.current.sorted);
    assert.equal(visible.length, i + 1);
    assert.equal(visible[i - 1].toolResult?.text, `out-${i}`);
    assert.equal(visible[i], saved);
    assert.equal(toolArrival.current.key, `${3 + (i - 1) * 2}:0`);
  }
});

test('actual ChatScreen: visible results update immediately, while orphan results and pending calls are paced', () => {
  const page = screen();
  sendToolBurst(page, 3);
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  const arrival = page.render().toolArrival.current;
  const result = { seq: 7, kind: 'tool_result', toolUseId: 't1', text: 'done' };
  const queuedResult = { seq: 8, kind: 'tool_result', toolUseId: 't3', text: 'waiting' };
  const orphan = { seq: 9, kind: 'tool_result', text: 'orphan' };
  for (const message of [result, queuedResult, orphan, orphan]) page.emit('ws:message', { sessionId: 'session', message });
  const visible = mergeToolMessages(page.render().store.current.sorted);
  assert.deepEqual(visible.map((m) => m.toolUseId), ['t1']);
  assert.equal(visible[0].toolResult, result);
  assert.equal(page.render().toolArrival.current, arrival, 'updating a result does not restart card entry');

  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  assert.equal(mergeToolMessages(page.render().store.current.sorted).length, 2);
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  assert.equal(mergeToolMessages(page.render().store.current.sorted)[2].toolResult, queuedResult);
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  assert.equal(mergeToolMessages(page.render().store.current.sorted)[3], orphan);
});

test('actual ChatScreen: tool result priority respects agent identity', () => {
  const page = screen();
  const mainUse = { seq: 1, kind: 'tool_use', toolUseId: 'shared', toolName: 'Read' };
  const agentUse = { seq: 2, kind: 'tool_use', toolUseId: 'shared', agentId: 'child', toolName: 'Read' };
  const mainResult = { seq: 3, kind: 'tool_result', toolUseId: 'shared', text: 'main' };
  const agentResult = { seq: 4, kind: 'tool_result', toolUseId: 'shared', agentId: 'child', text: 'child' };
  page.render().addMsgs([mainUse]);
  for (const message of [agentUse, agentResult, mainResult]) page.emit('ws:message', { sessionId: 'session', message });
  assert.deepEqual(page.render().store.current.sorted, [mainUse, mainResult]);
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  const visible = mergeToolMessages(page.render().store.current.sorted);
  assert.equal(visible[0].toolResult, mainResult);
  assert.equal(visible[1].toolResult, agentResult);
});

test('actual ChatScreen: history overlap cannot release a burst early, and changing session clears it', async () => {
  const page = screen();
  page.effects();
  await new Promise(setImmediate);
  const use = { seq: 2, kind: 'tool_use', toolUseId: 't1' };
  const result = { seq: 3, kind: 'tool_result', toolUseId: 't1', text: 'finished' };
  page.emit('ws:message', { sessionId: 'session', message: use });
  page.render().addMsgs([user, use, result]);
  assert.deepEqual(page.render().store.current.sorted, [user]);
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  assert.equal(mergeToolMessages(page.render().store.current.sorted)[1].toolResult, result);
  page.emit('ws:message', { sessionId: 'session', message: { ...use, seq: 4, toolUseId: 't2' } });
  page.render({ route: { params: { sessionId: 'next' } } });
  page.effects();
  page.flushTimers(TOOL_REVEAL_INTERVAL_MS);
  assert.deepEqual(page.render().store.current.sorted, []);
  assert.equal(page.render().toolArrival.current, null);
  page.unmount();
});
