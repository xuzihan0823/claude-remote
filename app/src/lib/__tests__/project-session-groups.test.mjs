import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectSessionGroups, drawerFocus, OPTIMISTIC_TTL } from '../project-session-groups.js';
import { normalizeCatalog } from '../projects.js';

const catalog = normalizeCatalog({ projects: [
  { id: '/repo/a', name: 'a', cwd: '/work/a', cwds: ['/work/a', '/outside/fix'], sessionCount: 121, lastActiveAt: 5 },
  { id: '/repo/b', name: 'b', cwd: '/work/b', cwds: ['/work/b'], sessionCount: 90, lastActiveAt: 2 },
], unclassifiedCount: 3, totalSessions: 214 });
const rows = (id, offset, count) => Array.from({ length: count }, (_, i) => ({ sessionId: `${id}:${offset + i}`, cwd: id === '' ? '' : `/work/${id.at(-1)}`, lastActiveAt: 1000 - offset - i }));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const group = (controller, id) => controller.getSnapshot().groups.find((g) => g.id === id);
function setup(fetchPage, options) {
  const controller = createProjectSessionGroups(fetchPage, () => {}, options);
  controller.update({ catalog, loaded: true });
  return controller;
}

test('complete headers are lazy; multiple projects page independently with server offsets', async () => {
  const calls = [];
  const controller = setup(async (limit, q) => {
    calls.push({ limit, ...q });
    return { sessions: rows(q.projectId, q.offset, Math.min(limit, 121 - q.offset)), total: 121 };
  });
  assert.equal(controller.getSnapshot().rows.length, 3);
  assert.equal(calls.length, 0);
  controller.toggle('/repo/a');
  controller.toggle('/repo/b');
  await settle();
  assert.deepEqual(calls.map((q) => [q.projectId, q.offset]), [['/repo/a', 0], ['/repo/b', 0]]);
  await controller.loadMore('/repo/a');
  await controller.loadMore('/repo/a');
  await controller.loadMore('/repo/b');
  assert.deepEqual(calls.slice(2).map((q) => [q.projectId, q.offset]), [['/repo/a', 50], ['/repo/a', 100], ['/repo/b', 50]]);
  assert.equal(group(controller, '/repo/a').sessionCount, 121);
  assert.equal(group(controller, '/repo/a').sessions.length, 121);
  assert.equal(group(controller, '/repo/b').sessions.length, 100);
  assert.equal(controller.getSnapshot().rows.filter((r) => r.type === 'footer').length, 2);
});

test('collapse caches rows; refresh marks collapsed groups dirty and only reloads open ones', async () => {
  const calls = [];
  const controller = setup(async (limit, q) => {
    calls.push(q);
    return { sessions: rows(q.projectId, 0, 1), total: 1 };
  });
  controller.toggle('/repo/a');
  await settle();
  controller.toggle('/repo/a');
  controller.toggle('/repo/a');
  await settle();
  assert.equal(calls.length, 1);
  controller.toggle('/repo/a');
  controller.toggle('/repo/b');
  await settle();
  controller.refresh();
  await settle();
  assert.deepEqual(calls.map((q) => q.projectId), ['/repo/a', '/repo/b', '/repo/b']);
  controller.toggle('/repo/a');
  await settle();
  assert.equal(calls.at(-1).projectId, '/repo/a');
  assert.equal(group(controller, '/repo/a').sessions.length, 1);
});

test('consecutive refreshes supersede pagination and older refresh responses', async () => {
  const pending = [];
  const controller = setup((_limit, q) => {
    const d = deferred();
    pending.push({ ...d, q });
    return d.promise;
  });
  controller.toggle('/repo/a');
  pending[0].resolve({ sessions: rows('/repo/a', 0, 50), total: 100 });
  await settle();
  const more = controller.loadMore('/repo/a');
  controller.refresh();
  controller.refresh();
  pending[3].resolve({ sessions: [{ sessionId: 'latest', cwd: '/work/a' }], total: 1 });
  await settle();
  pending[2].resolve({ sessions: [{ sessionId: 'old-refresh' }], total: 1 });
  pending[1].resolve({ sessions: rows('/repo/a', 50, 50), total: 100 });
  await more;
  await settle();
  assert.deepEqual(group(controller, '/repo/a').sessions.map((s) => s.sessionId), ['latest']);
  assert.equal(group(controller, '/repo/a').hasMore, false);
  assert.equal(controller.getSnapshot().loading, false);
});

test('collapsed in-flight pages are invalidated by refresh and catalog removal disposes entries', async () => {
  const late = deferred();
  let calls = 0;
  const controller = setup(() => ++calls === 1 ? Promise.resolve({ sessions: rows('/repo/a', 0, 50), total: 80 }) : late.promise);
  controller.toggle('/repo/a');
  await settle();
  const more = controller.loadMore('/repo/a');
  controller.toggle('/repo/a');
  controller.refresh();
  late.resolve({ sessions: rows('/repo/a', 50, 30), total: 80 });
  await more;
  assert.equal(group(controller, '/repo/a').sessions.length, 50);
  controller.update({ catalog: { ...catalog, projects: catalog.projects.slice(1) }, loaded: true });
  assert.equal(group(controller, '/repo/a'), undefined);
  controller.update({ catalog, loaded: true });
  assert.equal(group(controller, '/repo/a').sessions.length, 0);
  assert.equal(group(controller, '/repo/a').expanded, false);
});

test('dispose suppresses every late publication and further requests', async () => {
  const late = deferred();
  let publications = 0;
  let calls = 0;
  const controller = createProjectSessionGroups(() => { calls++; return late.promise; }, () => publications++);
  controller.update({ catalog, loaded: true });
  controller.toggle('/repo/a');
  controller.dispose();
  const before = publications;
  late.resolve({ sessions: rows('/repo/a', 0, 1), total: 1 });
  await settle();
  controller.toggle('/repo/b');
  controller.refresh();
  await controller.retry('/repo/a');
  assert.equal(publications, before);
  assert.equal(calls, 1);
});

test('worktree and unclassified optimistic rows deduplicate, expire, and never alter offsets', async () => {
  let clock = 100;
  const calls = [];
  const controller = setup(async (_limit, q) => {
    calls.push(q);
    return { sessions: q.offset ? [] : rows(q.projectId, 0, 50), total: 60 };
  }, { now: () => clock });
  const optimistic = [
    { sessionId: 'pending', cwd: '/outside/fix', createdAt: 100, lastActiveAt: 2000 },
    { sessionId: '/repo/a:0', cwd: '/outside/fix', title: 'optimistic', createdAt: 100 },
    { sessionId: 'old', createdAt: 100 },
    { sessionId: 'unknown', cwd: '/unknown', createdAt: 100 },
  ];
  controller.update({ catalog, loaded: true, optimistic });
  controller.toggle('/repo/a');
  controller.toggle('');
  await settle();
  assert.equal(group(controller, '/repo/a').sessions.length, 51);
  assert.equal(group(controller, '/repo/a').sessions.find((s) => s.sessionId === '/repo/a:0').cwd, '/work/a');
  assert.equal(group(controller, '').sessions.some((s) => s.sessionId === 'old'), true);
  assert.equal(group(controller, '/repo/b').sessions.length, 0);
  await controller.loadMore('/repo/a');
  assert.equal(calls.at(-1).offset, 50);
  assert.equal(calls.find((q) => q.projectId === '').offset, 0);
  clock += OPTIMISTIC_TTL;
  controller.expireOptimistic();
  assert.equal(group(controller, '/repo/a').sessions.some((s) => s.sessionId === 'pending'), false);
  assert.equal(group(controller, '').sessions.some((s) => s.sessionId === 'old'), false);
});

test('default expansion waits for known metadata, respects manual collapse, and follows a different Chat once', async () => {
  const controller = setup(async () => ({ sessions: [], total: 0 }));
  controller.update({ catalog, loaded: true, focus: { name: 'Chat', sessionId: 'a' } });
  assert.equal(controller.getSnapshot().groups.some((g) => g.expanded), false);
  controller.update({ catalog, loaded: true, focus: { name: 'Chat', sessionId: 'a', meta: { cwd: '/outside/fix' } } });
  assert.equal(group(controller, '/repo/a').expanded, true);
  controller.toggle('/repo/a');
  controller.update({ catalog, loaded: true, refresh: true, focus: { name: 'Chat', sessionId: 'a', meta: { cwd: '/outside/fix' } } });
  assert.equal(group(controller, '/repo/a').expanded, false);
  controller.update({ catalog, loaded: true, focus: { name: 'Chat', sessionId: 'b', meta: { cwd: '/work/a' } } });
  assert.equal(group(controller, '/repo/a').expanded, true);
  controller.update({ catalog, loaded: true, focus: { name: 'Chat', sessionId: 'legacy', meta: { sessionId: 'legacy' } } });
  assert.equal(group(controller, '').expanded, true);
});

test('Home opens the most recently active project once and polling never reopens it', async () => {
  const controller = setup(async () => ({ sessions: [], total: 0 }));
  controller.update({ catalog, loaded: true, focus: { name: 'Home' } });
  assert.equal(group(controller, '/repo/a').expanded, true);
  controller.toggle('/repo/a');
  controller.update({ catalog, loaded: true, focus: { name: 'Home' }, refresh: true });
  assert.equal(group(controller, '/repo/a').expanded, false);
});

test('unresolved nested navigation never resets a manual expansion choice', () => {
  const controller = setup(async () => ({ sessions: [], total: 0 }));
  controller.update({ catalog, loaded: true, focus: { name: 'Main' } });
  controller.toggle('/repo/a');
  controller.toggle('/repo/a');
  controller.update({ catalog, loaded: true, focus: { name: 'Home' } });
  assert.equal(group(controller, '/repo/a').expanded, false);
  controller.update({ catalog, loaded: true, focus: {} });
  controller.update({ catalog, loaded: true, focus: { name: 'Home' } });
  assert.equal(group(controller, '/repo/a').expanded, false);
  controller.update({ catalog, loaded: true, focus: { name: 'Chat', sessionId: 'b', meta: { cwd: '/work/b' } } });
  assert.equal(group(controller, '/repo/b').expanded, true);
});

test('Home opens Unclassified when no runnable projects exist and respects manual collapse', async () => {
  const calls = [];
  const controller = setup(async (_limit, q) => {
    calls.push(q);
    return { sessions: rows('', 0, 3), total: 3 };
  });
  const onlyUnclassified = { projects: [], unclassifiedCount: 3, totalSessions: 3 };
  const update = () => controller.update({ catalog: onlyUnclassified, loaded: true, focus: { name: 'Home' } });
  update();
  await settle();
  assert.equal(group(controller, '').expanded, true);
  assert.deepEqual(calls, [{ offset: 0, projectId: '' }]);
  controller.toggle('');
  update();
  assert.equal(group(controller, '').expanded, false);
  assert.equal(calls.length, 1);
});

test('live optimistic status survives catalog/cache updates until an authoritative row replaces it', async () => {
  let sessions = [];
  const controller = setup(async () => ({ sessions, total: sessions.length }));
  const optimistic = [{ sessionId: 'new', cwd: '/work/a', status: 'daemon-driving', createdAt: Date.now() }];
  controller.update({ catalog, loaded: true, optimistic });
  controller.toggle('/repo/a');
  await settle();
  controller.setStatus('new', 'idle');
  assert.equal(group(controller, '/repo/a').sessions[0].status, 'idle');
  controller.update({ catalog: { ...catalog }, loaded: true, optimistic, refresh: true });
  await settle();
  assert.equal(group(controller, '/repo/a').sessions[0].status, 'idle');
  sessions = [{ sessionId: 'new', cwd: '/work/a', status: 'terminal-driving' }];
  controller.refresh();
  await settle();
  assert.equal(group(controller, '/repo/a').sessions[0].status, 'terminal-driving');
});

test('first-page and pagination errors retry independently without losing useful rows', async () => {
  const calls = [];
  let fail = true;
  const controller = setup(async (_limit, q) => {
    calls.push(q);
    if (q.projectId === '/repo/a' && fail) throw { code: 'network_error' };
    return { sessions: rows(q.projectId, q.offset, q.offset ? 10 : 50), total: 60 };
  });
  controller.toggle('/repo/a');
  controller.toggle('/repo/b');
  await settle();
  assert.equal(group(controller, '/repo/a').error, '网络不可达');
  assert.equal(group(controller, '/repo/b').error, '');
  fail = false;
  await controller.retry('/repo/a');
  assert.equal(group(controller, '/repo/a').error, '');
  fail = true;
  await controller.loadMore('/repo/a');
  assert.equal(group(controller, '/repo/a').moreError, '网络不可达');
  assert.equal(group(controller, '/repo/a').sessions.length, 50);
  fail = false;
  await controller.loadMore('/repo/a');
  assert.equal(calls.at(-1).offset, 50);
  assert.equal(group(controller, '/repo/a').sessions.length, 60);
});

test('nested drawer navigation resolves only the active leaf and duplicate project titles remain distinct', () => {
  assert.deepEqual(drawerFocus({ index: 0, routes: [{ name: 'Main', state: { index: 1, routes: [{ name: 'Home' }, { name: 'Chat', params: { sessionId: 'current' } }] } }] }), { name: 'Chat', sessionId: 'current' });
  assert.deepEqual(drawerFocus(undefined), { name: undefined, sessionId: undefined });
  const controller = setup(async () => ({ sessions: [], total: 0 }));
  controller.update({ catalog: normalizeCatalog({ projects: [
    { id: '/one/parent/app', name: 'app' }, { id: '/two/parent/app', name: 'app' },
  ] }), loaded: true });
  const titles = controller.getSnapshot().groups.map((g) => g.title);
  assert.notEqual(titles[0], titles[1]);
});
