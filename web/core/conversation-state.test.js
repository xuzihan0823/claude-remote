import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationState, displayKey, newClientMessageId } from './conversation-state.js';

const userRow = (seq, uuid, text) => ({ seq, blockIndex: 0, uuid, role: 'user', kind: 'text', text });
const assistantRow = (seq, apiMessageId, text, blockIndex = 0) => ({
  seq, blockIndex, uuid: `assistant-${seq}-${blockIndex}`, role: 'assistant', kind: 'text', text, apiMessageId,
});
const seqs = (state) => state.items().map((m) => m.seq);

test('client message ids are UUID-shaped', () => {
  assert.match(newClientMessageId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('addLocal reuses a provided clientMessageId and keeps displayKey stable', () => {
  const state = createConversationState();
  const clientMessageId = '11111111-1111-4111-8111-111111111111';
  const local = state.addLocal('provided id', clientMessageId);
  const key = displayKey(local);

  assert.equal(local.clientMessageId, clientMessageId);
  assert.equal(local.uuid, clientMessageId);
  assert.equal(key, `u:${clientMessageId}`);

  state.markAccepted(clientMessageId, 'run-1');
  assert.equal(displayKey(state.items()[0]), key);
  assert.equal(state.addLocal('generated id').clientMessageId.length, 36);
});

test('identical trimmed text from a different uuid confirms the local as a fallback', () => {
  const state = createConversationState();
  state.addLocal('  hello there  ');

  state.upsertOfficial(userRow(4, 'server-side-uuid', 'hello there'));

  assert.equal(state.pendingLocals().length, 0);
  assert.equal(state.items().length, 1);
  assert.equal(state.items()[0].uuid, 'server-side-uuid');
});

test('identical pending texts pair with identical official rows in arrival order', () => {
  const state = createConversationState();
  state.addLocal('same text');
  const second = state.addLocal('same text');

  state.upsertOfficial(userRow(1, 'server-1', 'same text'));
  assert.equal(state.pendingLocals().length, 1);
  assert.equal(state.pendingLocals()[0].clientMessageId, second.clientMessageId);

  state.upsertOfficial(userRow(2, 'server-2', 'same text'));
  assert.equal(state.pendingLocals().length, 0);
  assert.equal(state.items().length, 2);
  assert.deepEqual(state.items().map((m) => m.uuid), ['server-1', 'server-2']);
});

test('a snapshot containing both identical rows confirms both pending locals', () => {
  const state = createConversationState();
  state.addLocal('duplicate');
  state.addLocal('duplicate');

  state.applySnapshot({
    messages: [userRow(5, 'server-5', 'duplicate'), userRow(6, 'server-6', 'duplicate')],
    firstSeq: 5,
  });

  assert.equal(state.pendingLocals().length, 0);
  assert.deepEqual(state.items().map((m) => m.seq), [5, 6]);
});

test('echo before the 202 removes the local and keeps one item', () => {
  const state = createConversationState();
  const local = state.addLocal('hello');
  const key = displayKey(local);
  assert.equal(key, `u:${local.clientMessageId}`);
  assert.equal(local.status, 'sending');

  state.upsertOfficial(userRow(7, local.clientMessageId, 'hello'));

  assert.equal(state.items().length, 1);
  assert.equal(state.items()[0].seq, 7);
  assert.equal(displayKey(state.items()[0]), key);
  assert.equal(state.pendingLocals().length, 0);

  state.markAccepted(local.clientMessageId, 'run-1');
  state.markFailed(local.clientMessageId, { definite: true });
  assert.equal(state.items().length, 1);
  assert.equal(state.pendingLocals().length, 0);
});

test('two identical pending texts stay distinct', () => {
  const state = createConversationState();
  const first = state.addLocal('same text');
  const second = state.addLocal('same text');

  assert.notEqual(first.clientMessageId, second.clientMessageId);
  assert.notEqual(displayKey(first), displayKey(second));
  assert.equal(state.items().length, 2);
  assert.deepEqual(state.pendingLocals().map((m) => m.text), ['same text', 'same text']);
});

test('a late error after confirmation does not regress the confirmed row', () => {
  const state = createConversationState();
  const local = state.addLocal('already there');
  state.upsertOfficial(userRow(3, local.clientMessageId, 'already there'));

  state.markFailed(local.clientMessageId, { definite: true });
  state.markUnconfirmed(local.clientMessageId);
  state.markAccepted(local.clientMessageId, 'run-late');

  assert.equal(state.items().length, 1);
  assert.equal(state.items()[0].seq, 3);
  assert.equal(state.items()[0].status, undefined);
  assert.equal(state.pendingLocals().length, 0);
});

test('stream deltas accumulate per block and are capped per item', () => {
  const state = createConversationState();
  const first = state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'Hel' });
  const key = first.key;
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'lo' });
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 1, text: 'world' });

  const items = state.items();
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'Hello');
  assert.equal(items[0].role, 'assistant');
  assert.equal(items[0].kind, 'text');
  assert.equal(items[0].key, key);
  assert.equal(items[1].text, 'world');
  assert.notEqual(items[1].key, key);

  const big = state.applyStream({ runId: 'r1', messageId: 'm2', blockIndex: 0, text: 'x'.repeat(40_000) });
  assert.equal(big.text.length, 32768);
});

test('an official row replaces matching streaming items by apiMessageId', () => {
  const state = createConversationState();
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'par' });
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 1, text: 'tial' });

  state.upsertOfficial(assistantRow(10, 'm1', 'partial answer'));

  const items = state.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].seq, 10);
  assert.equal(items[0].text, 'partial answer');
});

test('a reconnect snapshot replaces an already-finalized streaming reply', () => {
  const state = createConversationState();
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'partial' });

  state.applySnapshot({ messages: [assistantRow(10, 'm1', 'partial answer')], firstSeq: 10 });

  assert.equal(state.items().length, 1);
  assert.equal(state.items()[0].seq, 10);

  state.applyStream({ runId: 'r1', messageId: 'm2', blockIndex: 0, text: 'still streaming' });
  state.applySnapshot({ messages: [assistantRow(10, 'm1', 'partial answer')], firstSeq: 10 });

  assert.equal(state.items().length, 2);
  assert.ok(state.items().some((m) => m.role === 'assistant' && m.messageId === 'm2' && m.seq === undefined));
});

test('an attachment-annotated official row confirms the local bubble', () => {
  const state = createConversationState();
  state.addLocal('hello');

  state.upsertOfficial(userRow(5, 'server-uuid', 'hello\n\n[手机端上传的附件，已保存在本机，可直接读取]\n- /tmp/a.png'));

  assert.equal(state.pendingLocals().length, 0);
  assert.equal(state.items().length, 1);
  assert.equal(state.items()[0].uuid, 'server-uuid');

  const nearMiss = createConversationState();
  nearMiss.addLocal('ok');
  nearMiss.upsertOfficial(userRow(1, 'u1', 'ok done'));
  assert.equal(nearMiss.pendingLocals().length, 1);
});

test('stream snapshot replaces one run and clearStream leaves other runs alone', () => {
  const state = createConversationState();
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'old0' });
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 1, text: 'old1' });
  state.applyStream({ runId: 'r2', messageId: 'm2', blockIndex: 0, text: 'other' });

  state.applyStreamSnapshot({
    runId: 'r1',
    blocks: [
      { messageId: 'm1', blockIndex: 0, text: 'new0' },
      { messageId: 'm1', blockIndex: 1, text: 'new1' },
    ],
  });

  const afterSnapshot = state.items().filter((m) => m.role === 'assistant');
  assert.equal(afterSnapshot.length, 3);
  assert.deepEqual(afterSnapshot.filter((m) => m.runId === 'r1').map((m) => m.text), ['new0', 'new1']);
  assert.equal(afterSnapshot.filter((m) => m.runId === 'r2').length, 1);

  state.clearStream('r1');
  const remaining = state.items();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, 'other');
});

test('a snapshot over an overlapping window keeps ascending order', () => {
  const state = createConversationState();
  state.applySnapshot({
    messages: [assistantRow(1, 'a1', 'one'), userRow(2, 'u2', 'two'), assistantRow(3, 'a3', 'three')],
    firstSeq: 1,
    hasMore: true,
  });
  assert.deepEqual(seqs(state), [1, 2, 3]);
  assert.equal(state.hasMore(), true);
  assert.equal(state.hasGap(), false);

  state.applySnapshot({
    messages: [assistantRow(3, 'a3b', 'three replaced'), assistantRow(4, 'a4', 'four')],
    firstSeq: 3,
    hasMore: false,
  });

  assert.deepEqual(seqs(state), [1, 2, 3, 4]);
  assert.equal(state.items()[2].text, 'three replaced');
  assert.equal(state.hasMore(), false);
  assert.equal(state.hasGap(), false);
});

test('a non-overlapping snapshot keeps old rows and reports a gap until bridged', () => {
  const state = createConversationState();
  state.applySnapshot({ messages: [assistantRow(1, 'a1', 'one'), assistantRow(2, 'a2', 'two')], firstSeq: 1 });
  state.applySnapshot({ messages: [assistantRow(5, 'a5', 'five'), assistantRow(6, 'a6', 'six')], firstSeq: 5 });

  assert.deepEqual(seqs(state), [1, 2, 5, 6]);
  assert.equal(state.hasGap(), true);

  state.applySnapshot({
    messages: [assistantRow(3, 'a3', 'three'), assistantRow(4, 'a4', 'four'), assistantRow(5, 'a5b', 'five again')],
    firstSeq: 3,
  });

  assert.deepEqual(seqs(state), [1, 2, 3, 4, 5]);
  assert.equal(state.items()[4].text, 'five again');
  assert.equal(state.hasGap(), false);
});

test('snapshot confirmation removes matching locals and blocks are sorted by blockIndex', () => {
  const state = createConversationState();
  const local = state.addLocal('confirmed by snapshot');
  state.upsertOfficial(assistantRow(8, 'a8', 'second block', 1));
  state.upsertOfficial(assistantRow(8, 'a8', 'first block', 0));

  state.applySnapshot({
    messages: [assistantRow(8, 'a8', 'first block', 0), assistantRow(8, 'a8', 'second block', 1), userRow(9, local.clientMessageId, 'confirmed by snapshot')],
    firstSeq: 8,
  });

  assert.equal(state.pendingLocals().length, 0);
  assert.equal(state.items().length, 3);
  assert.deepEqual(state.items().map((m) => m.blockIndex), [0, 1, 0]);
  assert.equal(state.items()[2].seq, 9);
});

test('reset clears official, local, streaming, and gap state', () => {
  const state = createConversationState();
  state.addLocal('pending');
  state.applyStream({ runId: 'r1', messageId: 'm1', blockIndex: 0, text: 'x' });
  state.applySnapshot({ messages: [assistantRow(10, 'a10', 'ten')], firstSeq: 10 });
  state.applySnapshot({ messages: [assistantRow(20, 'a20', 'twenty')], firstSeq: 20 });
  assert.equal(state.hasGap(), true);

  state.reset();

  assert.equal(state.items().length, 0);
  assert.equal(state.pendingLocals().length, 0);
  assert.equal(state.hasGap(), false);
  assert.equal(state.hasMore(), false);
});
