import { useEffect, useRef, useState } from 'react';
import { searchSessionsApi } from '../../../web/core/api.js';
import { createSessionSearch, emptySearchState } from '../../../web/core/search.js';

/** 抽屉会话搜索：先标题/路径，再全文。返回 { state, setQuery, retry }。 */
export function useSessionSearch() {
  const [state, setState] = useState(emptySearchState);
  const ref = useRef(null);
  if (ref.current === null) ref.current = createSessionSearch(searchSessionsApi, setState);
  useEffect(() => () => ref.current?.dispose(), []);
  return { state, setQuery: (q) => ref.current.setQuery(q), retry: () => ref.current.retry() };
}
