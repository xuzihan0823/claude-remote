import { mergeSessions, projectForCwd, projectTitles } from './projects.js';
import { createSessionPager } from './session-pager.js';

export const OPTIMISTIC_TTL = 120_000;

export function drawerFocus(state) {
  let route;
  while (state?.routes?.length) {
    route = state.routes[state.index ?? 0];
    state = route?.state;
  }
  return { name: route?.name, sessionId: route?.name === 'Chat' ? route.params?.sessionId : undefined };
}

export function createProjectSessionGroups(fetchPage, publish, { now = Date.now } = {}) {
  let catalog = { projects: [], unclassifiedCount: 0 };
  let loaded = false;
  let optimistic = [];
  let focus = {};
  let focusKey;
  let defaultApplied = false;
  let disposed = false;
  const entries = new Map();
  const expanded = new Set();
  const optimisticStatuses = new Map();

  const pendingRows = () => optimistic.filter((s) => now() - s.createdAt < OPTIMISTIC_TTL);
  const owner = (s) => s ? (s.cwd ? projectForCwd(catalog.projects, s.cwd)?.id : '') : undefined;
  const definitions = () => {
    const titles = projectTitles(catalog.projects);
    const counts = new Map();
    for (const title of titles.values()) counts.set(title, (counts.get(title) || 0) + 1);
    const groups = catalog.projects.map((p) => ({
      ...p,
      title: counts.get(titles.get(p.id)) > 1 ? `${p.name} · ${p.id}` : titles.get(p.id),
    }));
    if (catalog.unclassifiedCount > 0 || pendingRows().some((s) => !s.cwd) || owner(focus.meta) === '') {
      groups.push({ id: '', title: '未归类', sessionCount: catalog.unclassifiedCount, cwds: [] });
    }
    return groups;
  };

  const snapshot = () => {
    const pending = pendingRows();
    const groups = definitions().map((p) => {
      const entry = entries.get(p.id);
      const state = entry?.state || { items: [], total: p.sessionCount, loading: false, error: '', loadingMore: false, moreError: '' };
      const sessions = mergeSessions(pending.filter((s) => owner(s) === p.id), state.items);
      return { ...p, ...state, sessions, expanded: expanded.has(p.id), hasMore: !!entry && !entry.dirty && entry.pager.hasMore(), refreshing: !!entry?.refreshing };
    });
    const rows = groups.flatMap((group) => [
      { type: 'project', key: `project:${group.id}`, group },
      ...(group.expanded ? [
        ...group.sessions.map((session) => ({ type: 'session', key: `session:${group.id}:${session.sessionId}`, group, session })),
        { type: 'footer', key: `footer:${group.id}`, group },
      ] : []),
    ]);
    return { groups, rows, loading: groups.some((g) => g.expanded && (g.loading || g.refreshing)) };
  };
  const emit = () => { if (!disposed) publish(snapshot()); };

  const ensure = (id) => {
    if (!entries.has(id)) {
      const entry = { dirty: true, version: 0, refreshing: false, state: { items: [], total: 0, loading: true, error: '', loadingMore: false, moreError: '' } };
      entry.pager = createSessionPager(fetchPage, (state) => {
        if (disposed || entries.get(id) !== entry) return;
        entry.state = state;
        emit();
      });
      entries.set(id, entry);
    }
    return entries.get(id);
  };
  const reload = async (id) => {
    if (disposed || !definitions().some((p) => p.id === id)) return;
    const entry = ensure(id);
    const version = ++entry.version;
    entry.dirty = false;
    entry.refreshing = true;
    await entry.pager.refresh(id);
    if (disposed || entries.get(id) !== entry || version !== entry.version) return;
    entry.refreshing = false;
    emit();
  };
  const open = (id) => {
    expanded.add(id);
    if (ensure(id).dirty) void reload(id);
  };
  const invalidate = () => {
    for (const entry of entries.values()) {
      entry.version += 1;
      entry.pager.dispose();
      entry.dirty = true;
      entry.refreshing = false;
      entry.state = { ...entry.state, loading: false, loadingMore: false };
    }
  };

  return {
    update({ catalog: nextCatalog, loaded: nextLoaded, optimistic: nextOptimistic = [], focus: nextFocus = {}, refresh = false }) {
      if (disposed) return;
      catalog = nextCatalog;
      loaded = nextLoaded;
      optimistic = nextOptimistic.map((s) => optimisticStatuses.has(s.sessionId)
        ? { ...s, status: optimisticStatuses.get(s.sessionId) } : s);
      const pendingIds = new Set(pendingRows().map((s) => s.sessionId));
      for (const id of optimisticStatuses.keys()) if (!pendingIds.has(id)) optimisticStatuses.delete(id);
      focus = nextFocus;
      const key = focus.name === 'Chat' && focus.sessionId ? `Chat:${focus.sessionId}`
        : focus.name === 'Home' ? 'Home' : undefined;
      if (key !== undefined && key !== focusKey) {
        if (focusKey !== undefined) defaultApplied = false;
        focusKey = key;
      }
      const ids = new Set(definitions().map((p) => p.id));
      for (const [id, entry] of entries) {
        if (ids.has(id)) continue;
        entry.pager.dispose();
        entries.delete(id);
        expanded.delete(id);
      }
      if (refresh) invalidate();
      if (loaded && !defaultApplied) {
        const id = focus.name === 'Chat' ? owner(focus.meta)
          : focus.name === 'Home' ? [...catalog.projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id
            ?? (ids.has('') ? '' : undefined) : undefined;
        if (id !== undefined && ids.has(id)) { defaultApplied = true; open(id); }
      }
      for (const id of expanded) if (ensure(id).dirty) void reload(id);
      emit();
    },
    toggle(id) {
      if (disposed || !definitions().some((p) => p.id === id)) return;
      defaultApplied = true;
      if (expanded.has(id)) expanded.delete(id);
      else open(id);
      emit();
    },
    refresh() {
      if (disposed) return;
      invalidate();
      for (const id of expanded) void reload(id);
      emit();
    },
    retry: reload,
    loadMore(id) {
      if (disposed || !expanded.has(id)) return;
      const entry = entries.get(id);
      if (!entry || entry.dirty) return reload(id);
      return entry.pager.loadMore();
    },
    setStatus(sessionId, status) {
      if (disposed) return;
      if (pendingRows().some((s) => s.sessionId === sessionId)) optimisticStatuses.set(sessionId, status);
      optimistic = optimistic.map((s) => s.sessionId === sessionId ? { ...s, status } : s);
      for (const entry of entries.values()) entry.pager.setStatus(sessionId, status);
      emit();
    },
    expireOptimistic: emit,
    getSnapshot: snapshot,
    dispose() {
      disposed = true;
      for (const entry of entries.values()) entry.pager.dispose();
      entries.clear();
      expanded.clear();
      optimisticStatuses.clear();
    },
  };
}
