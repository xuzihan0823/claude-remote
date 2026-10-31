import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMessageEcho, newClientMessageId, reconcilePending, sendFailureState } from './message-delivery.js';

const message = { role: 'user', kind: 'text', text: 'same', seq: 1, uuid: 'first' };
test('matching prefers identity and only uses text for legacy requests', () => {
  assert.equal(isMessageEcho(message, { text: 'different', clientMessageId: 'first' }), true);
  assert.equal(isMessageEcho(message, { text: 'same', clientMessageId: 'second' }), false);
  assert.equal(isMessageEcho(message, { text: 'same', clientMessageId: 'second', precise: false }), true);
  assert.equal(isMessageEcho({ ...message, role: 'assistant' }, { text: 'same', precise: false }), false);
  const pending = [{ text: 'same', clientMessageId: 'first' }, { text: 'same', clientMessageId: 'second' }];
  assert.deepEqual(reconcilePending(pending, [message]), [pending[1]]);
  assert.equal(reconcilePending(pending, [message, { ...message, seq: 2, uuid: 'second' }]).length, 0);
  assert.equal(reconcilePending([{ text: 'same', precise: false, floorSeq: 1 }], [message]).length, 1);
  assert.equal(reconcilePending([{ ...pending[0], floorSeq: 1 }], [message]).length, 0, 'UUID 确认不受重试时已更新的分页边界限制');
});
test('failure state distinguishes rejection and unknown delivery', () => {
  assert.equal(sendFailureState({ status: 0 }, true), 'unconfirmed');
  assert.equal(sendFailureState({ status: 503 }, true), 'unconfirmed');
  assert.equal(sendFailureState({ status: 400 }, true), 'failed');
  assert.equal(sendFailureState({ status: 0 }, false), 'failed');
});
test('UUID generation works without crypto.randomUUID in Hermes', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const ids = new Set(Array.from({ length: 100 }, newClientMessageId));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});
