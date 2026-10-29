// 移植 web/ui/hooks.js 的 useModelCatalog：fetchModels + bus 'ws-open'/'models-cached'。
// RN 端 useEffect 由 react 直接提供（metro 把 vendor preact-htm-standalone 重定向到
// src/shims/preact-htm.js，该 shim 仅 re-export useEffect；useState/useCallback 这里从 react 取）。
import { useCallback, useEffect, useState } from 'react';
import { useBus } from '../../../web/core/bus.js';
import { fetchModels, modelCache } from '../../../web/core/api.js';

export function useModelCatalog() {
  const [catalog, setCatalog] = useState(modelCache);
  const load = useCallback(async () => {
    try { setCatalog(await fetchModels()); } catch { /* 拿不到就跟随项目默认，composer 仍可用 */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useBus('ws-open', load, [load]);
  useBus('models-cached', setCatalog, []);
  return catalog;
}
