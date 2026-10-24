import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionSearch, mergeResults } from './search.js';

const tick = () => new Promise((r) => setImmediate(r));
function fakeTimers() {
  const tasks = [];
  return { setTimer: (fn) => { tasks.push(fn); return tasks.length; }, clearTimer: (id) => { tasks[id - 1] = null; }, flush: () => { for (const [i, fn] of tasks.entries()) { if (fn) { tasks[i] = null; fn(); } } } };
}

test('mergeResults：同一会话只保留 meta 命中', () => {
  assert.deepEqual(mergeResults([{ sessionId: 'a', m: 1 }], [{ sessionId: 'a', m: 2 }, { sessionId: 'b' }]).map((r) => r.sessionId), ['a', 'b']);
});

test('先出 meta 结果，再追加全文结果', async () => {
  const calls = [];
  const states = [];
  const t = fakeTimers();
  const search = createSessionSearch(async (q, { full }) => {
    calls.push([q, full]);
    return full ? { results: [{ sessionId: 'a' }, { sessionId: 'c' }], truncated: true } : { results: [{ sessionId: 'a' }] };
  }, (s) => states.push(s), t);
  search.setQuery(' bug ');
  assert.equal(search.state.loading, true);
  t.flush(); await tick(); await tick();
  assert.deepEqual(calls, [['bug', false], ['bug', true]]);
  assert.deepEqual(search.state.results.map((r) => r.sessionId), ['a', 'c']);
  assert.equal(search.state.truncated, true);
  assert.equal(search.state.fullLoading, false);
  assert.ok(states.some((s) => s.fullLoading && s.results.length === 1));
});

test('防抖 + 过期结果丢弃；清空回到初始态', async () => {
  const t = fakeTimers();
  let release;
  const search = createSessionSearch(async (q) => {
    if (q === 'old') await new Promise((r) => { release = r; });
    return { results: [{ sessionId: q }] };
  }, () => {}, t);
  search.setQuery('old');
  t.flush(); await tick();
  search.setQuery('new');
  t.flush(); await tick(); await tick();
  release(); await tick(); await tick();
  assert.deepEqual(search.state.results.map((r) => r.sessionId), ['new']);
  search.setQuery('');
  assert.deepEqual(search.state.results, []);
  assert.equal(search.state.loading, false);
});

test('出错给提示，不抛', async () => {
  const t = fakeTimers();
  const search = createSessionSearch(async () => { const e = new Error('x'); e.code = 'network_error'; throw e; }, () => {}, t);
  search.setQuery('x');
  t.flush(); await tick();
  assert.equal(search.state.error, '网络不可达');
  assert.equal(search.state.loading, false);
});

import { findFocusIndex, loadUntilSeq } from './search.js';

test('loadUntilSeq：翻页到覆盖目标 seq 为止', async () => {
  const calls = [];
  const fetchBefore = async (before) => { calls.push(before); return { messages: [{ seq: before - 100 }], firstSeq: before - 100, hasMore: before - 100 > 1 }; };
  const r = await loadUntilSeq(fetchBefore, { firstSeq: 401, hasMore: true }, 150);
  assert.deepEqual(calls, [401, 301, 201]);
  assert.equal(r.firstSeq, 101);
  assert.equal(r.messages.length, 3);
  const none = await loadUntilSeq(fetchBefore, { firstSeq: 100, hasMore: true }, 150);
  assert.deepEqual(none.messages, []);
});

test('findFocusIndex：同 seq 或其后最近一条', () => {
  const s = [{ seq: 3 }, { seq: 5 }, { seq: 9 }];
  assert.equal(findFocusIndex(s, 5), 1);
  assert.equal(findFocusIndex(s, 6), 2);
  assert.equal(findFocusIndex(s, 10), -1);
});
