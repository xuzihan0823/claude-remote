import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
const connection = await import('./api.js');
const {
  api, defaultModelDescription, fetchModels, fetchProjects, fetchSessions, getSessionModel, modelSelection, modelTriggerLabel, probeBase,
  resetModelCache, saveConn, sessionCache, setSessionModel,
} = connection;
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

test('a model removed from a loaded catalog is shown as unavailable, never as the default', () => {
  const catalog = { models: [{ id: 'codex/gpt-6.1-terra', alias: 'codex/gpt-6.1-terra' }], defaultModel: 'deepseek', loaded: true };
  assert.deepEqual(modelSelection(catalog, ''), { status: 'default', model: null });
  assert.equal(modelSelection(catalog, 'codex/gpt-6.1-terra').status, 'ok');
  assert.equal(modelSelection(catalog, 'zcode/glm-5.3').status, 'unavailable');
  assert.equal(modelTriggerLabel(catalog, 'zcode/glm-5.3'), 'zcode/glm-5.3（不可用）');
  assert.equal(modelTriggerLabel(catalog, ''), '跟随项目默认');
  // 内置别名不在目录里也被 daemon 接受
  assert.equal(modelSelection(catalog, 'opus').status, 'ok');
});

test('before the catalog loads, a chosen model is kept as-is instead of looking like the default', () => {
  const notLoaded = { models: [], defaultModel: '', loaded: false };
  assert.equal(modelSelection(notLoaded, 'codex/gpt-6.1-terra').status, 'unverified');
  assert.equal(modelTriggerLabel(notLoaded, 'codex/gpt-6.1-terra'), 'codex/gpt-6.1-terra');
});

test('model catalog from a previous connection is discarded and reset empties it', async () => {
  saveConn('http://old.local:8788', 'old');
  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve(Response.json({ models: [{ id: 'old-model' }] })); });
  const pending = fetchModels();
  saveConn('http://new.local:8788', 'new');
  resetModelCache();
  release();
  await assert.rejects(pending, { code: 'connection_changed' });
  assert.equal(connection.modelCache.loaded, false);
  assert.equal(connection.modelCache.models.length, 0);
});

test('each session remembers its own model choice; empty means follow the default', () => {
  setSessionModel('s1', 'codex/gpt-6.1-terra');
  setSessionModel('s2', 'opus');
  assert.equal(getSessionModel('s1'), 'codex/gpt-6.1-terra');
  assert.equal(getSessionModel('s2'), 'opus');
  setSessionModel('s1', '');
  assert.equal(getSessionModel('s1'), '');
  assert.equal(getSessionModel('never-set'), '');
});

test('default copy identifies user settings without promising the effective project model', () => {
  const catalog = { models: [{ id: 'provider/user-A', alias: 'sonnet' }], defaultModel: 'sonnet', loaded: true };
  assert.equal(modelTriggerLabel(catalog, ''), '跟随项目默认');
  assert.equal(defaultModelDescription(catalog), '用户配置默认：provider/user-A；实际运行遵循当前项目配置');
  assert.equal(defaultModelDescription(null), '实际运行遵循当前项目配置');
});
