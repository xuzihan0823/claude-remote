import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../haptics.js', import.meta.url), 'utf8');

function load({ os = 'ios', missing = false, nativeAndroid = true } = {}) {
  const calls = [];
  const state = { currentState: 'active' };
  let enabled = true;
  let now = 10000;
  const native = {
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
    NotificationFeedbackType: { Warning: 'warning', Success: 'success', Error: 'error' },
    AndroidHaptics: { Confirm: 'confirm', Gesture_End: 'gesture-end', Virtual_Key: 'virtual-key', Segment_Tick: 'segment-tick', Reject: 'reject', Long_Press: 'long-press' },
    impactAsync: (kind) => { calls.push(['impact', kind]); },
    notificationAsync: (kind) => { calls.push(['notification', kind]); },
    selectionAsync: () => { calls.push(['selection']); },
    ...(nativeAndroid ? { performAndroidHapticsAsync: (kind) => { calls.push(['android', kind]); } } : {}),
  };
  const body = source.replace(/^import .*;\n/gm, '').replace('export const haptics', 'const haptics');
  const haptics = new Function('AppState', 'Platform', 'getPref', 'require', 'Date', `${body}\nreturn haptics;`)(
    state, { OS: os }, () => enabled, () => {
      if (missing) throw new Error('native module unavailable');
      return native;
    }, { now: () => now },
  );
  return { haptics, calls, state, native, enable: (value) => { enabled = value; }, advance: (ms) => { now += ms; } };
}

test('haptics respect the preference and foreground state for every effect', () => {
  const env = load();
  const playAll = () => Object.values(env.haptics).forEach((play) => play());
  env.enable(false);
  playAll();
  env.enable(true);
  for (const state of ['background', 'inactive', null]) {
    env.state.currentState = state;
    playAll();
  }
  assert.deepEqual(env.calls, []);
  env.state.currentState = 'active';
  env.haptics.attention();
  assert.deepEqual(env.calls, [['notification', 'warning']], 'suppressed reminders must not consume the cooldown');
});

test('iOS distinguishes selection, tap, stop, confirmation and outcome feedback', () => {
  const { haptics, calls } = load();
  for (const kind of ['selection', 'tap', 'stop', 'confirm', 'success', 'error']) haptics[kind]();
  assert.deepEqual(calls, [
    ['selection'], ['impact', 'light'], ['impact', 'medium'], ['impact', 'light'],
    ['notification', 'success'], ['notification', 'error'],
  ]);
});

test('Android uses native semantic effects and falls back when the API is unavailable', () => {
  const env = load({ os: 'android' });
  for (const kind of ['selection', 'tap', 'stop', 'confirm', 'success', 'error', 'attention']) env.haptics[kind]();
  assert.deepEqual(env.calls, ['segment-tick', 'virtual-key', 'gesture-end', 'confirm', 'confirm', 'reject', 'long-press'].map((kind) => ['android', kind]));
  const fallback = load({ os: 'android', nativeAndroid: false });
  fallback.haptics.selection();
  fallback.haptics.attention();
  assert.deepEqual(fallback.calls, [['selection'], ['notification', 'warning']]);
});

test('approval bursts produce at most one reminder per second without muting errors', () => {
  const env = load();
  env.haptics.attention();
  env.haptics.attention();
  env.advance(999);
  env.haptics.attention();
  env.haptics.error();
  env.advance(1);
  env.haptics.attention();
  assert.deepEqual(env.calls, [['notification', 'warning'], ['notification', 'error'], ['notification', 'warning']]);
});

test('missing native modules and native failures never interrupt an action', async () => {
  const missing = load({ missing: true });
  for (const play of Object.values(missing.haptics)) assert.doesNotThrow(play);
  const env = load();
  env.native.impactAsync = () => { throw new Error('unsupported'); };
  env.native.notificationAsync = () => Promise.reject(new Error('unsupported'));
  assert.doesNotThrow(env.haptics.tap);
  assert.doesNotThrow(env.haptics.error);
  await new Promise(setImmediate);
});
