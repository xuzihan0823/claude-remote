// 会话搜索控制器（web 与 iOS App 共用，无 UI 依赖）。
//
// 输入防抖后分两步：先 meta（标题/路径/最近预览，毫秒级）立刻出结果，再 full（扫 JSONL 全文）
// 把正文命中追加在后面。每次输入递增 generation，过期请求的结果直接丢弃。

export const SEARCH_DEBOUNCE_MS = 250;

export const MATCH_LABEL = { title: '标题', cwd: '路径', preview: '最近消息', content: '正文' };

export function emptySearchState(query = '') {
  return { query, results: [], loading: false, fullLoading: false, truncated: false, error: '' };
}

/** 合并 meta 与 full 结果：同一会话只保留第一次（meta 优先）。 */
export function mergeResults(a, b) {
  const seen = new Set(a.map((r) => r.sessionId));
  return [...a, ...b.filter((r) => !seen.has(r.sessionId))];
}

export function createSessionSearch(searchFn, onChange, { debounceMs = SEARCH_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = emptySearchState();
  let gen = 0;
  let timer = null;
  const set = (patch) => { state = { ...state, ...patch }; onChange(state); };

  async function run(q, myGen) {
    try {
      const meta = await searchFn(q, { full: false });
      if (myGen !== gen) return;
      set({ results: meta.results || [], loading: false, fullLoading: true, error: '' });
      const full = await searchFn(q, { full: true });
      if (myGen !== gen) return;
      set({ results: mergeResults(state.results, full.results || []), fullLoading: false, truncated: !!full.truncated });
    } catch (e) {
      if (myGen !== gen || e?.code === 'connection_changed') return;
      set({ loading: false, fullLoading: false, error: e?.code === 'network_error' ? '网络不可达' : `搜索失败：${e?.code || 'unknown'}` });
    }
  }

  return {
    get state() { return state; },
    setQuery(raw) {
      const q = String(raw ?? '');
      gen += 1;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (q.trim() === '') { state = emptySearchState(q); onChange(state); return; }
      set({ query: q, loading: true, fullLoading: false, truncated: false, error: '' });
      const myGen = gen;
      timer = setTimer(() => { timer = null; void run(q.trim(), myGen); }, debounceMs);
    },
    retry() { this.setQuery(state.query); },
    dispose() { gen += 1; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
