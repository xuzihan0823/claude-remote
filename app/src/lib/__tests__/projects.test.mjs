import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PROJECTS, UNCLASSIFIED, filterCount, filterLabel, mergeSessions, normalizeCatalog,
  parsePref, prefKey, projectForCwd, projectTitles, resolveTarget, sessionMatchesFilter, sessionQuery,
} from '../projects.js';

const catalog = normalizeCatalog({
  projects: [
    { id: '/r/app', name: 'app', cwd: '/w/app-fix', cwds: ['/w/app-fix', '/r/app-sub'], sessionCount: 5, lastActiveAt: 3 },
    { id: '/a/foo', name: 'foo', cwd: '/a/foo', cwds: ['/a/foo'], sessionCount: 2, lastActiveAt: 2 },
    { id: '/b/foo', name: 'foo', cwd: '/b/foo', cwds: ['/b/foo'], sessionCount: 1, lastActiveAt: 1 },
  ],
  totalSessions: 11,
  unclassifiedCount: 3,
});

test('同名项目用父目录区分，不合并', () => {
  const t = projectTitles(catalog.projects);
  assert.equal(t.get('/r/app'), 'app');
  assert.notEqual(t.get('/a/foo'), t.get('/b/foo'));
  assert.equal(t.get('/a/foo'), 'foo · a');
});

test('筛选的查询参数：全部省略 projectId，未归类传空串', () => {
  assert.deepEqual(sessionQuery(ALL_PROJECTS), {});
  assert.deepEqual(sessionQuery(UNCLASSIFIED), { projectId: '' });
  assert.deepEqual(sessionQuery('/r/app'), { projectId: '/r/app' });
});

test('数量来自完整目录而非已加载页', () => {
  assert.equal(filterCount(catalog, ALL_PROJECTS), 11);
  assert.equal(filterCount(catalog, UNCLASSIFIED), 3);
  assert.equal(filterCount(catalog, '/r/app'), 5);
  assert.equal(filterCount(catalog, '/gone'), 0);
  assert.equal(filterLabel(catalog, '/gone/proj'), 'proj');
});

test('worktree 按实际 cwd 归属项目，仓库根不是可执行目标', () => {
  assert.equal(projectForCwd(catalog.projects, '/w/app-fix')?.id, '/r/app');
  assert.equal(projectForCwd(catalog.projects, '/r/app'), null);
  assert.equal(resolveTarget(catalog.projects, '/r/app', null), '/w/app-fix');
});

test('目录刷新保留已选择/继承目标，失效 cwd 不换目录，无 cwd 旧会话必须显式选择', () => {
  assert.equal(resolveTarget(catalog.projects, ALL_PROJECTS, '/b/foo'), '/b/foo');
  assert.equal(resolveTarget(catalog.projects, '/a/foo', '/deleted'), '/deleted');
  assert.equal(resolveTarget(catalog.projects, ALL_PROJECTS, '/deleted'), '/deleted');
  assert.equal(resolveTarget(catalog.projects, '/a/foo', ''), '');
  assert.equal(resolveTarget(catalog.projects, UNCLASSIFIED, ''), '');
  assert.equal(resolveTarget(catalog.projects, ALL_PROJECTS, null), null);
  assert.equal(resolveTarget(catalog.projects, '/a/foo', null), '/a/foo');
});

test('分页与刷新合并按 sessionId 去重，新数据覆盖并按时间排序', () => {
  const merged = mergeSessions(
    [{ sessionId: 'a', lastActiveAt: 1, status: 'idle' }, { sessionId: 'b', lastActiveAt: 5 }],
    [{ sessionId: 'a', lastActiveAt: 9, status: 'daemon-driving' }, { sessionId: 'c', lastActiveAt: 3 }],
  );
  assert.deepEqual(merged.map((s) => s.sessionId), ['a', 'b', 'c']);
  assert.equal(merged[0].status, 'daemon-driving');
});

test('乐观条目只出现在匹配的筛选里', () => {
  const s = { sessionId: 'n', cwd: '/r/app-sub' };
  assert.ok(sessionMatchesFilter(catalog.projects, s, ALL_PROJECTS));
  assert.ok(sessionMatchesFilter(catalog.projects, s, '/r/app'));
  assert.ok(!sessionMatchesFilter(catalog.projects, s, '/a/foo'));
  assert.ok(!sessionMatchesFilter(catalog.projects, s, UNCLASSIFIED));
  assert.ok(sessionMatchesFilter(catalog.projects, { sessionId: 'x' }, UNCLASSIFIED));
});

test('偏好键只含连接地址，不含 token；坏数据回退为全部', () => {
  assert.equal(prefKey('http://mac:7777/'), 'cr_project_pref:v1:http://mac:7777');
  assert.deepEqual(parsePref('not json'), { projectId: ALL_PROJECTS, cwd: null });
  assert.deepEqual(parsePref(JSON.stringify({ projectId: '', cwd: '/a/foo' })), { projectId: '', cwd: '/a/foo' });
});

test('目录数据防御：cwd 缺失时取 cwds 首项，非法项目丢弃', () => {
  const c = normalizeCatalog({ projects: [{ id: '/x', cwds: ['/x/w'] }, { name: 'bad' }] });
  assert.equal(c.projects.length, 1);
  assert.equal(c.projects[0].cwd, '/x/w');
  assert.equal(c.projects[0].name, 'x');
  assert.deepEqual(normalizeCatalog(null).projects, []);
});
