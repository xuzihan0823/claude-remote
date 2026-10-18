import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
const { createSession } = await import('../create-session.js');
const { saveConn } = await import('../../../../web/core/api.js');
after(() => { globalThis.localStorage = originalStorage; globalThis.fetch = originalFetch; });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('creation captures the exact original workspace and selected model before attachment uploads', async () => {
  saveConn('http://first:8788', 'test');
  const upload = deferred();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('file:')) return new Response('file');
    if (url.includes('/upload')) return upload.promise;
    return Response.json({ sessionId: 'created', runId: 'run' });
  };
  const input = { cwd: '/worktree/original', text: 'hello', model: 'provider/model', mode: 'plan', files: [{ uri: 'file:///fixture', name: 'doc.txt' }] };
  const request = createSession(input);
  input.cwd = '/another/workspace';
  upload.resolve(Response.json({ path: '/uploads/doc.txt' }));
  const { body } = await request;
  assert.equal(body.cwd, '/worktree/original');
  assert.equal(body.model, 'provider/model');
  assert.equal(body.permissionMode, 'plan');
  assert.ok(body.text.includes('/uploads/doc.txt'));
  assert.equal(JSON.parse(calls.at(-1).opts.body).cwd, '/worktree/original');
});

test('switching connection during local attachment reads prevents upload and creation on the new daemon', async () => {
  saveConn('http://first:8788', 'test');
  const local = deferred();
  const calls = [];
  globalThis.fetch = (url) => { calls.push(url); return local.promise; };
  const request = createSession({ cwd: '/old/worktree', text: 'hello', mode: 'default', files: [{ uri: 'file:///fixture', name: 'doc.txt' }] });
  saveConn('http://second:8788', 'test');
  local.resolve(new Response('file'));
  await assert.rejects(request, { code: 'connection_changed' });
  assert.deepEqual(calls, ['file:///fixture']);
});

test('a delayed creation response cannot navigate or populate state after a connection change', async () => {
  saveConn('http://first:8788', 'first');
  const remote = deferred();
  globalThis.fetch = () => remote.promise;
  const request = createSession({ cwd: '/workspace', text: 'hello', mode: 'default', files: [] });
  saveConn('http://first:8788', 'second');
  remote.resolve(Response.json({ sessionId: 'old-session', runId: 'run' }));
  await assert.rejects(request, { code: 'connection_changed' });
});
