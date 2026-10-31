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
  const input = { cwd: '/worktree/original', text: 'hello', model: 'provider/model', effort: 'high', mode: 'plan', files: [{ uri: 'file:///fixture', name: 'doc.txt' }] };
  const request = createSession(input);
  input.cwd = '/another/workspace';
  input.effort = 'low';
  upload.resolve(Response.json({ path: '/uploads/doc.txt' }));
  const { body } = await request;
  assert.equal(body.cwd, '/worktree/original');
  assert.equal(body.model, 'provider/model');
  assert.equal(body.effort, 'high');
  assert.equal(body.permissionMode, 'plan');
  assert.ok(body.text.includes('/uploads/doc.txt'));
  const sentBody = JSON.parse(calls.at(-1).opts.body);
  assert.equal(sentBody.cwd, '/worktree/original');
  assert.equal(sentBody.effort, 'high');
});

test('creation omits effort when default empty string is used', async () => {
  saveConn('http://first:8788', 'test');
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return Response.json({ sessionId: 'created', runId: 'run' });
  };
  const { body } = await createSession({ cwd: '/worktree/original', text: 'hello', effort: '', mode: 'default', files: [] });
  assert.equal(Object.hasOwn(body, 'effort'), false);
  assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).opts.body), 'effort'), false);
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

test('creation retry reuses UUID and prepared body after a lost response without uploading again', async () => {
  saveConn('http://example.com', 'test');
  let uploads = 0;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('file:')) return new Response('file');
    if (url.includes('/upload')) { uploads++; return Response.json({ path: '/uploads/doc.txt' }); }
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) throw new Error('response lost');
    return Response.json({ sessionId: 'original', runId: 'run', clientMessageId: bodies[0].clientMessageId });
  };
  const request = {};
  const input = { cwd: '/workspace', text: 'original text', mode: 'default', files: [{ uri: 'file:///fixture', name: 'doc.txt' }], request };
  await assert.rejects(createSession(input), { code: 'network_error' });
  const { result } = await createSession(input);
  assert.equal(result.sessionId, 'original');
  assert.equal(uploads, 1);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.match(bodies[0].clientMessageId, /^[a-f0-9-]{36}$/);
});
