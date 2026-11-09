import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeCatalog, parsePref, pathTail, prefKey, resolveTarget } from '../projects.js';
import { scopeErrMsg } from '../../../../web/core/errors.js';

const source = readFileSync(new URL('../projects-context.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function ProjectsProvider({ base, children }) {') + 'export function ProjectsProvider({ base, children }) {'.length, source.indexOf('  return <ProjectsContext.Provider'));
const settle = () => new Promise(setImmediate);

function mount(fetchProjects) {
  const slots = [];
  const effects = [];
  const handlers = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const toasts = [];
  const cleanups = [];
  const appHandlers = new Set();
  let cursor = 0;
  let timerId = 0;
  let mounted = false;
  const AppState = {
    currentState: 'active',
    addEventListener(_name, handler) { appHandlers.add(handler); return { remove: () => appHandlers.delete(handler) }; },
  };
  const ws = { state: { phase: 'open' } };
  const dependencies = {
    base: 'https://example.com',
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(fn) { if (!mounted) effects.push(fn); },
    useBus: (name, fn) => handlers.set(name, fn),
    localStorage: { getItem: () => null, setItem() {} },
    setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout(fn) { timeouts.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timeouts.delete(id),
    fetchProjects, AppState, ws, normalizeCatalog, parsePref, pathTail, prefKey, resolveTarget, scopeErrMsg,
    toast: (text, kind) => toasts.push({ text, kind }),
    t: (text) => text,
  };
  const run = new Function(...Object.keys(dependencies), `${body}\nreturn value;`);
  const render = () => { cursor = 0; return run(...Object.values(dependencies)); };
  render();
  for (const effect of effects) cleanups.push(effect());
  mounted = true;
  return {
    render, toasts, ws,
    changeState(state) { AppState.currentState = state; for (const fn of appHandlers) fn(state); },
    emit: (name) => handlers.get(name)?.(),
    poll() { for (const fn of intervals.values()) fn(); },
    unmount() { for (const fn of cleanups) fn?.(); },
  };
}

test('foreground waits for ws-open and automatic polling skips background and disconnected states', async () => {
  let calls = 0;
  const provider = mount(async () => { calls++; return { projects: [] }; });
  await settle();
  assert.equal(calls, 1);
  provider.changeState('background');
  provider.poll();
  provider.emit('ws-open');
  assert.equal(calls, 1);
  provider.changeState('active');
  assert.equal(calls, 1);
  provider.ws.state.phase = 'connecting';
  provider.poll();
  assert.equal(calls, 1);
  provider.ws.state.phase = 'open';
  provider.emit('ws-open');
  await settle();
  assert.equal(calls, 2);
  assert.equal(provider.render().listSignal.automatic, true);
  provider.poll();
  await settle();
  assert.equal(calls, 3);
  provider.unmount();
});

test('automatic failures preserve catalog and inline errors; manual refresh reports failure and recovery clears it', async () => {
  let fail = false;
  const provider = mount(async () => {
    if (fail) throw { code: 'network_error' };
    return { projects: [{ id: '/repo', name: 'repo' }] };
  });
  await settle();
  fail = true;
  provider.emit('ws-open');
  await settle();
  assert.equal(provider.render().catalog.projects.length, 1);
  assert.equal(provider.render().catalogLoaded, true);
  assert.equal(provider.render().catalogError, '项目列表：网络不可达');
  assert.deepEqual(provider.toasts, []);
  provider.render().refresh();
  await settle();
  assert.equal(provider.render().listSignal.automatic, false);
  assert.deepEqual(provider.toasts, [{ text: '项目列表：网络不可达', kind: 'error' }]);
  fail = false;
  provider.emit('ws-open');
  await settle();
  assert.equal(provider.render().catalogError, '');
  provider.unmount();
});

test('initial and obsolete-channel failures avoid global error notifications', async () => {
  for (const code of ['network_error', 'connection_changed']) {
    const provider = mount(async () => { throw { code }; });
    await settle();
    assert.equal(provider.render().catalogError, code === 'network_error' ? '项目列表：网络不可达' : '');
    assert.deepEqual(provider.toasts, []);
    if (code === 'connection_changed') {
      provider.render().refresh();
      await settle();
      assert.equal(provider.render().catalogError, '');
      assert.deepEqual(provider.toasts, []);
    }
    provider.unmount();
  }
});
