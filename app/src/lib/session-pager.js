import { mergeSessions, SESSION_PAGE, sessionQuery } from './projects.js';

const initialState = () => ({ items: [], total: 0, loading: true, error: '', loadingMore: false, moreError: '' });
const errorText = (e) => e.code === 'unauthorized' ? '' : e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`;

export function createSessionPager(fetchPage, publish) {
  let state = initialState();
  let generation = 0;
  let projectId = null;
  let offset = 0;
  let refreshing = false;
  let moreBusy = false;

  const update = (patch) => { state = { ...state, ...patch }; publish(state); };

  return {
    async refresh(nextProjectId, reset = false) {
      const current = ++generation;
      projectId = nextProjectId;
      const query = sessionQuery(projectId);
      const wanted = reset ? SESSION_PAGE : Math.max(SESSION_PAGE, offset);
      refreshing = true;
      moreBusy = false;
      if (reset) { offset = 0; state = initialState(); }
      update({ loading: reset || state.items.length === 0, loadingMore: false, moreError: '' });
      try {
        let items = [];
        let consumed = 0;
        let total = 0;
        do {
          const res = await fetchPage(Math.min(500, wanted - consumed), { offset: consumed, ...query });
          if (current !== generation) return;
          const rows = res.sessions || [];
          items = mergeSessions(items, rows);
          total = Number(res.total) || 0;
          consumed += rows.length;
          if (rows.length === 0) break;
        } while (consumed < wanted && consumed < total);
        offset = consumed;
        update({ items, total, loading: false, error: '' });
      } catch (e) {
        if (current === generation) update({ loading: false, error: errorText(e) });
      } finally {
        if (current === generation) refreshing = false;
      }
    },
    async loadMore() {
      if (refreshing || moreBusy || offset >= state.total) return;
      const current = generation;
      const query = sessionQuery(projectId);
      moreBusy = true;
      update({ loadingMore: true, moreError: '' });
      try {
        const res = await fetchPage(SESSION_PAGE, { offset, ...query });
        if (current !== generation) return;
        const rows = res.sessions || [];
        const total = Number(res.total) || 0;
        offset = rows.length ? offset + rows.length : total;
        update({ items: mergeSessions(state.items, rows), total, loadingMore: false, moreError: '' });
      } catch (e) {
        if (current === generation) update({ loadingMore: false, moreError: errorText(e) });
      } finally {
        if (current === generation) moreBusy = false;
      }
    },
    setStatus(sessionId, status) {
      if (state.items.some((s) => s.sessionId === sessionId)) {
        update({ items: state.items.map((s) => s.sessionId === sessionId ? { ...s, status } : s) });
      }
    },
    hasMore: () => offset < state.total,
    dispose() { generation += 1; },
  };
}
