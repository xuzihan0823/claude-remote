import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrefsStore, DEFAULT_PREFS, fontScaleLabel, PREFS_KEY, sanitizePrefs } from '../prefs-store.js';

const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};

test('无数据时全部默认值', () => {
  const s = createPrefsStore({ storage: mem() });
  assert.deepEqual(s.all(), DEFAULT_PREFS);
});

test('set 持久化并回调；新 store 能读回', () => {
  const storage = mem();
  const calls = [];
  const s = createPrefsStore({ storage, onChange: (next, name) => calls.push([name, next[name]]) });
  s.set('appearance', 'dark');
  s.set('fontScale', 1.16);
  s.set('haptics', false);
  assert.deepEqual(calls, [['appearance', 'dark'], ['fontScale', 1.16], ['haptics', false]]);
  const again = createPrefsStore({ storage });
  assert.equal(again.get('appearance'), 'dark');
  assert.equal(again.get('fontScale'), 1.16);
  assert.equal(again.get('haptics'), false);
  assert.equal(again.get('codeWrap'), false, '没改的项仍是默认');
});

test('非法值不写入、不回调；未知项抛错', () => {
  const storage = mem();
  let n = 0;
  const s = createPrefsStore({ storage, onChange: () => { n += 1; } });
  s.set('appearance', 'purple');
  s.set('fontScale', 3);
  assert.equal(n, 0);
  assert.equal(storage.m.has(PREFS_KEY), false);
  assert.throws(() => s.set('nope', 1), /unknown pref/);
});

test('存储里的坏数据逐项回落默认', () => {
  assert.deepEqual(sanitizePrefs({ appearance: 'light', fontScale: 9, haptics: 'yes', extra: 1 }), { ...DEFAULT_PREFS, appearance: 'light' });
  const s = createPrefsStore({ storage: mem({ [PREFS_KEY]: '{broken' }) });
  assert.deepEqual(s.all(), DEFAULT_PREFS);
});

test('fontScaleLabel', () => {
  assert.equal(fontScaleLabel(1), '标准');
  assert.equal(fontScaleLabel(0.88), '较小');
  assert.equal(fontScaleLabel(2), '标准');
});
