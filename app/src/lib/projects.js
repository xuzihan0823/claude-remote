// 项目目录的纯逻辑（无 RN 依赖，可用 node --test 直接测）。
// 浏览筛选值：null = 全部，'' = 未归类，其余 = 项目 id（仓库根完整路径）。

export const ALL_PROJECTS = null;
export const UNCLASSIFIED = '';
export const SESSION_PAGE = 50;

const EMPTY_CATALOG = { projects: [], totalSessions: 0, unclassifiedCount: 0 };

export function normalizeCatalog(d) {
  if (!d || !Array.isArray(d.projects)) return EMPTY_CATALOG;
  const projects = d.projects
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p) => {
      const cwds = Array.isArray(p.cwds) ? p.cwds.filter((c) => typeof c === 'string' && c) : [];
      const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : cwds[0] || '';
      return {
        id: p.id,
        name: typeof p.name === 'string' && p.name ? p.name : pathTail(p.id, 1),
        cwd,
        cwds: cwd && !cwds.includes(cwd) ? [cwd, ...cwds] : cwds,
        sessionCount: Number(p.sessionCount) || 0,
        lastActiveAt: Number(p.lastActiveAt) || 0,
      };
    });
  return {
    projects,
    totalSessions: Number(d.totalSessions) || 0,
    unclassifiedCount: Number(d.unclassifiedCount) || 0,
  };
}

export function pathTail(path, segs = 2) {
  if (!path) return '';
  return path.split('/').filter(Boolean).slice(-segs).join('/');
}

export function shortPath(path) {
  if (!path) return '';
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

// 同名项目追加父目录区分，避免同 basename 的两个仓库在列表里不可分辨
export function projectTitles(projects) {
  const counts = new Map();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  const titles = new Map();
  for (const p of projects) {
    const parent = pathTail(p.id.split('/').slice(0, -1).join('/'), 1);
    titles.set(p.id, counts.get(p.name) > 1 && parent ? `${p.name} · ${parent}` : p.name);
  }
  return titles;
}

export function projectForCwd(projects, cwd) {
  if (!cwd) return null;
  return projects.find((p) => p.cwds.includes(cwd)) || null;
}

export function isKnownCwd(projects, cwd) {
  return !!projectForCwd(projects, cwd);
}

export function filterLabel(catalog, projectId) {
  if (projectId === ALL_PROJECTS) return '全部对话';
  if (projectId === UNCLASSIFIED) return '未归类';
  const p = catalog.projects.find((x) => x.id === projectId);
  return p ? projectTitles(catalog.projects).get(p.id) : pathTail(projectId, 1) || projectId;
}

export function filterCount(catalog, projectId) {
  if (projectId === ALL_PROJECTS) return catalog.totalSessions;
  if (projectId === UNCLASSIFIED) return catalog.unclassifiedCount;
  return catalog.projects.find((x) => x.id === projectId)?.sessionCount ?? 0;
}

export function sessionQuery(projectId) {
  return projectId === ALL_PROJECTS ? {} : { projectId };
}

export function sessionMatchesFilter(projects, session, projectId) {
  if (projectId === ALL_PROJECTS) return true;
  if (projectId === UNCLASSIFIED) return !session.cwd;
  return projectForCwd(projects, session.cwd)?.id === projectId;
}

// 分页合并：按 sessionId 去重（后到的数据覆盖），按活跃时间降序
export function mergeSessions(existing, incoming) {
  const map = new Map();
  for (const s of existing) map.set(s.sessionId, s);
  for (const s of incoming) map.set(s.sessionId, { ...map.get(s.sessionId), ...s });
  return [...map.values()].sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}

// null 表示尚未选择；空串表示从无 cwd 会话继承，必须由用户选择。
export function resolveTarget(projects, projectId, cwd) {
  if (cwd !== null) return cwd;
  if (projectId) {
    const p = projects.find((x) => x.id === projectId);
    if (p?.cwd) return p.cwd;
  }
  return null;
}

export function prefKey(base) {
  return `cr_project_pref:v1:${String(base || '').replace(/\/+$/, '')}`;
}

export function parsePref(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return {
      projectId: typeof v.projectId === 'string' ? v.projectId : ALL_PROJECTS,
      cwd: typeof v.cwd === 'string' ? v.cwd : null,
    };
  } catch { return { projectId: ALL_PROJECTS, cwd: null }; }
}
