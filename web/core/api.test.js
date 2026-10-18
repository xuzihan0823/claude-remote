import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
const connection = await import('./api.js');
const { api, fetchProjects, fetchSessions, probeBase, saveConn, sessionCache } = connection;
const { bus } = await import('./bus.js');
after(() => {
  globalThis.localStorage = originalStorage;
  globalThis.fetch = originalFetch;
});

test('session requests preserve literal project paths, empty unclassified filters, and paging', async () => {
  saveConn('http://localhost:8788', 'test');
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return Response.json({ sessions: [], total: 0 });
  };
  await fetchSessions(25, { offset: 50, projectId: '/工程/repo & fix?x=1', cwd: '/工程/worktree#2' });
  assert.equal(urls[0].searchParams.get('projectId'), '/工程/repo & fix?x=1');
  assert.equal(urls[0].searchParams.get('cwd'), '/工程/worktree#2');
  assert.equal(urls[0].searchParams.get('offset'), '50');
  assert.equal(urls[0].searchParams.get('limit'), '25');
  await fetchSessions(100, { projectId: '' });
  assert.equal(urls[1].searchParams.has('projectId'), true);
  assert.equal(urls[1].searchParams.get('projectId'), '');
  await fetchSessions(100);
  assert.equal(urls[2].searchParams.has('projectId'), false);
});

test('responses from a previous connection never populate the current session cache', async () => {
  saveConn('http://localhost:8788', 'first');
  sessionCache.clear();
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = fetchSessions();
  saveConn('http://localhost:8788', 'second');
  finish(Response.json({ sessions: [{ sessionId: 'old', cwd: '/old' }], total: 1 }));
  await assert.rejects(pending, { code: 'connection_changed' });
  assert.equal(sessionCache.has('old'), false);
  globalThis.fetch = async () => Response.json({ sessions: [{ sessionId: 'new', cwd: '/new' }], total: 1 });
  await fetchSessions();
  assert.equal(sessionCache.get('new').cwd, '/new');
});

test('project catalog is read from its authenticated endpoint without truncation parameters', async () => {
  saveConn('http://localhost:8788', 'project-test');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8788/api/projects');
    assert.equal(options.headers.Authorization, 'Bearer project-test');
    return Response.json({ projects: [], totalSessions: 501, unclassifiedCount: 1 });
  };
  assert.equal((await fetchProjects()).totalSessions, 501);
});

test('old unauthorized responses cannot sign out a newer connection', async () => {
  saveConn('http://old:8788', 'old');
  let finish;
  let unauthorized = 0;
  const off = bus.on('unauthorized', () => { unauthorized += 1; });
  try {
    globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
    const pending = api('/api/projects');
    saveConn('http://new:8788', 'new');
    finish(Response.json({ error: 'unauthorized' }, { status: 401 }));
    await assert.rejects(pending, { code: 'connection_changed' });
    assert.equal(unauthorized, 0);
    globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
    await assert.rejects(api('/api/projects'), { code: 'unauthorized' });
    assert.equal(unauthorized, 1);
  } finally { off(); }
});

test('probing a candidate leaves the active connection and project requests scoped to the current daemon', async () => {
  saveConn('http://current:8788', 'current');
  let finish;
  globalThis.fetch = async (url, options) => {
    if (url === 'http://candidate:8788/api/health') return new Promise((resolve) => { finish = resolve; });
    assert.equal(url, 'http://current:8788/api/projects');
    assert.equal(options.headers.Authorization, 'Bearer current');
    return Response.json({ projects: [], totalSessions: 7 });
  };
  const probe = probeBase('http://candidate:8788', 'candidate');
  assert.equal((await fetchProjects()).totalSessions, 7);
  finish(Response.json({ error: 'unauthorized' }, { status: 401 }));
  await assert.rejects(probe, { code: 'unauthorized' });
  assert.equal(connection.baseUrl, 'http://current:8788');
  assert.equal(connection.token, 'current');
});
