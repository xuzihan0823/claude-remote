import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionPager } from '../session-pager.js';
import { mergeSessions } from '../projects.js';

const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ sessionId: String(start + i), lastActiveAt: 1000 - start - i }));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('refresh replaces the loaded prefix after deletion, preserves pagination, and clears an empty project', async () => {
  let data = rows(0, 120);
  let state;
  const requests = [];
  const pager = createSessionPager(async (limit, query) => {
    requests.push({ limit, ...query });
    return { sessions: data.slice(query.offset, query.offset + limit), total: data.length };
  }, (s) => { state = s; });
  await pager.refresh('/project', true);
  await pager.loadMore();
  assert.equal(state.items.length, 100);
  data = data.slice(1);
  await pager.refresh('/project');
  assert.equal(state.items.length, 100);
  assert.equal(state.items.some((s) => s.sessionId === '0'), false);
  assert.equal(state.items.at(-1).sessionId, '100');
  await pager.loadMore();
  assert.equal(requests.at(-1).offset, 100);
  assert.equal(state.items.at(-1).sessionId, '119');
  assert.equal(pager.hasMore(), false);
  data = [];
  await pager.refresh('/project');
  assert.deepEqual(state.items, []);
  assert.equal(state.total, 0);
});

test('a refresh invalidates in-flight pagination and older filter requests', async () => {
  const late = deferred();
  const calls = [];
  let state;
  const pager = createSessionPager(async (limit, query) => {
    calls.push(query);
    if (query.offset === 50 || query.projectId === '/late') return late.promise;
    return { sessions: rows(query.projectId === '/new' ? 200 : 0, 50), total: 60 };
  }, (s) => { state = s; });
  await pager.refresh('/old', true);
  const paging = pager.loadMore();
  const oldFilter = pager.refresh('/late', true);
  await pager.refresh('/new', true);
  late.resolve({ sessions: rows(50, 10), total: 60 });
  await Promise.all([paging, oldFilter]);
  assert.equal(state.items[0].sessionId, '200');
  assert.equal(state.items.length, 50);
  assert.equal(state.loadingMore, false);
  assert.equal(calls.at(-1).projectId, '/new');
});

test('duplicate and optimistic rows do not become the server pagination offset', async () => {
  let state;
  let requestedOffset;
  const pager = createSessionPager(async (_limit, { offset }) => {
    requestedOffset = offset;
    if (offset === 0) return { sessions: rows(0, 50), total: 101 };
    if (offset === 50) return { sessions: rows(49, 50), total: 101 };
    return { sessions: rows(99, 1), total: 101 };
  }, (s) => { state = s; });
  await pager.refresh(null, true);
  await pager.loadMore();
  const optimistic = [{ sessionId: 'pending', lastActiveAt: 2000 }, state.items[0]];
  assert.equal(mergeSessions(optimistic, state.items).length, 100);
  await pager.loadMore();
  assert.equal(requestedOffset, 100);
  assert.equal(state.items.at(-1).sessionId, '99');
  assert.equal(pager.hasMore(), false);
});

test('empty tail pages settle pagination and disposed connections ignore delayed responses', async () => {
  let state;
  const tail = deferred();
  const pager = createSessionPager(async (_limit, { offset }) => offset === 0
    ? { sessions: rows(0, 50), total: 60 } : tail.promise, (s) => { state = s; });
  await pager.refresh('', true);
  const loading = pager.loadMore();
  tail.resolve({ sessions: [], total: 50 });
  await loading;
  assert.equal(state.total, 50);
  assert.equal(pager.hasMore(), false);
  const delayed = deferred();
  let publications = 0;
  const old = createSessionPager(() => delayed.promise, () => { publications += 1; });
  const request = old.refresh('/old', true);
  old.dispose();
  const before = publications;
  delayed.resolve({ sessions: rows(0, 1), total: 1 });
  await request;
  assert.equal(publications, before);
});
