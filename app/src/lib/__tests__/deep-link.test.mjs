import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { parseDeepLink } = await import('../deep-link.js');

test('approval 深链：id 与 session', () => {
  assert.deepEqual(parseDeepLink('claude-remote://approval/i%201?session=s-1'), {
    type: 'approval', interactionId: 'i 1', sessionId: 's-1',
  });
  assert.deepEqual(parseDeepLink('claude-remote://approval/abc'), { type: 'approval', interactionId: 'abc', sessionId: null });
});

test('session 深链', () => {
  assert.deepEqual(parseDeepLink('claude-remote://session/e5f6'), { type: 'session', sessionId: 'e5f6' });
});

test('setup 仍走配对解析', () => {
  const r = parseDeepLink('claude-remote://setup?token=t&bases=http%3A%2F%2F10.0.0.2%3A8787');
  assert.equal(r.type, 'setup');
  assert.equal(r.token, 't');
  assert.deepEqual(r.bases, ['http://10.0.0.2:8787']);
});

test('无关 / 残缺链接返回 null', () => {
  assert.equal(parseDeepLink('https://example.com'), null);
  assert.equal(parseDeepLink('claude-remote://approval'), null);
  assert.equal(parseDeepLink('claude-remote://whatever/1'), null);
  assert.equal(parseDeepLink(''), null);
});
