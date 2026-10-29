import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { effortLevelsPath, effortUsable, fetchEffortLevels, getSessionEffort, setSessionEffort } = await import('./effort.js');

test('session effort is stored per session and ignores invalid values', () => {
  setSessionEffort('a', 'high');
  setSessionEffort('b', 'low');
  assert.equal(getSessionEffort('a'), 'high');
  assert.equal(getSessionEffort('b'), 'low');
  setSessionEffort('a', '');
  assert.equal(getSessionEffort('a'), '');
  store.set('session_effort:c', '{"effort":"max"}');
  assert.equal(getSessionEffort('c'), '');
});

test('effort levels path prefers sessionId over cwd and encodes params', () => {
  assert.equal(effortLevelsPath({ sessionId: 's1', cwd: '/x', model: 'opus[1m]' }), '/api/effort-levels?sessionId=s1&model=opus%5B1m%5D');
  assert.equal(effortLevelsPath({ cwd: '/a b' }), '/api/effort-levels?cwd=%2Fa+b');
});

test('fetchEffortLevels keeps verified gateway levels and opens all five otherwise', async () => {
  const verified = await fetchEffortLevels({ cwd: '/x' }, async () => ({ levels: ['max', 'low', 'bogus'], verified: true }));
  assert.deepEqual(verified, { levels: ['low', 'max'], verified: true });
  const none = await fetchEffortLevels({ cwd: '/x' }, async () => ({ levels: [], verified: true }));
  assert.deepEqual(none, { levels: [], verified: true });
  const unverified = await fetchEffortLevels({ cwd: '/x' }, async () => ({ levels: ['low'], verified: false }));
  assert.deepEqual(unverified, { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: false });
});

test('effortUsable only blocks a level the gateway verified as missing', () => {
  const gateway = { levels: ['low', 'high'], verified: true };
  assert.equal(effortUsable(gateway, ''), true);
  assert.equal(effortUsable(gateway, 'high'), true);
  assert.equal(effortUsable(gateway, 'max'), false);
  assert.equal(effortUsable({ levels: [], verified: true }, 'low'), false);
  assert.equal(effortUsable({ levels: [], verified: false }, 'max'), true);
  assert.equal(effortUsable(null, 'max'), true);
});
