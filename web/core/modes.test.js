import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_MODES, getNewSessionMode, setNewSessionMode, getSessionMode, setSessionMode } from './modes.js';

test('auto persists through existing keys and invalid stored modes stay compatible', () => {
  const previous = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
  try {
    assert.equal(PERMISSION_MODES.includes('auto'), true);
    assert.equal(PERMISSION_MODES.includes('dontAsk'), false);
    setNewSessionMode('auto');
    setSessionMode('session', 'auto');
    assert.equal(data.get('session_mode'), 'auto');
    assert.equal(data.get('session_mode:session'), 'auto');
    assert.equal(getNewSessionMode(), 'auto');
    assert.equal(getSessionMode('session'), 'auto');
    data.set('session_mode:session', 'old-invalid');
    assert.equal(getSessionMode('session'), 'default');
    setNewSessionMode('dontAsk');
    assert.equal(getNewSessionMode(), 'default');
    assert.equal(getSessionMode('missing'), 'default');
  } finally { globalThis.localStorage = previous; }
});
