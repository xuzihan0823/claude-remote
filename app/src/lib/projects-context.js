import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchProjects } from '../../../web/core/api.js';
import { toast, useBus } from '../../../web/core/bus.js';
import {
  ALL_PROJECTS, normalizeCatalog, parsePref, pathTail,
  prefKey, resolveTarget,
} from './projects.js';

const ProjectsContext = createContext(null);
export const useProjects = () => useContext(ProjectsContext);

// 共享项目目录 + 浏览筛选 + Home 新建目标。App 按连接 key 重新挂载本 Provider；
// 偏好只按 base 存储（不含 token），卸载后 gen 递增，旧连接的异步响应一律丢弃。
export function ProjectsProvider({ base, children }) {
  const [catalog, setCatalog] = useState(() => normalizeCatalog(null));
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [projectId, setProjectId] = useState(() => parsePref(localStorage.getItem(prefKey(base))).projectId);
  const [target, setTargetState] = useState(() => parsePref(localStorage.getItem(prefKey(base))).cwd);
  const [listSignal, setListSignal] = useState(0);
  const [optimistic, setOptimistic] = useState([]);
  const gen = useRef(0);
  const catalogSeq = useRef(0);
  const draftActive = useRef(false);
  const timer = useRef(null);
  const state = useRef({ base, projectId, target, catalog });
  state.current = { base, projectId, target, catalog };

  const persist = (patch) => {
    const cur = state.current;
    const next = { projectId: cur.projectId, cwd: cur.target, ...patch };
    localStorage.setItem(prefKey(cur.base), JSON.stringify(next));
  };
  const setTarget = useCallback((cwd) => {
    if (cwd === state.current.target) return;
    state.current.target = cwd;
    setTargetState(cwd);
    persist({ cwd });
  }, []);

  const loadCatalog = useCallback(async () => {
    const g = gen.current;
    const seq = ++catalogSeq.current;
    try {
      const d = await fetchProjects();
      if (g !== gen.current || seq !== catalogSeq.current) return;
      setCatalog(normalizeCatalog(d));
      setCatalogLoaded(true);
      setCatalogError('');
    } catch (e) {
      if (g !== gen.current || seq !== catalogSeq.current || e.code === 'unauthorized') return;
      setCatalogError(e.code === 'network_error' ? '网络不可达' : `项目加载失败：${e.code}`);
    }
  }, []);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    loadCatalog();
    setListSignal((x) => x + 1);
  }, [loadCatalog]);
  const scheduleRefresh = useCallback((ms = 1500) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, ms);
  }, [refresh]);

  useEffect(() => {
    loadCatalog();
    return () => { gen.current += 1; clearTimeout(timer.current); };
  }, [loadCatalog]);

  // 只为未选择目标的新建页设置项目默认值；失效目录保留给用户显式更换。
  useEffect(() => {
    if (!catalogLoaded || draftActive.current || state.current.target !== null) return;
    setTarget(resolveTarget(catalog.projects, projectId, null));
  }, [catalog, catalogLoaded, projectId, setTarget]);

  useEffect(() => {
    const iv = setInterval(refresh, 30_000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { clearInterval(iv); sub.remove(); };
  }, [refresh]);
  useBus('ws-open', refresh, [refresh]);
  // status 只在轮次开始/结束时到达，合并后再刷，避免每条消息全量拉取
  useBus('ws:status', () => scheduleRefresh(), [scheduleRefresh]);

  const selectProject = useCallback((id) => {
    const cur = state.current;
    if (id === cur.projectId) return;
    state.current.projectId = id;
    setProjectId(id);
    persist({ projectId: id });
    const p = id ? cur.catalog.projects.find((x) => x.id === id) : null;
    if (!p?.cwd || p.cwds.includes(cur.target)) return;
    if (draftActive.current) {
      if (cur.target) toast(`草稿仍发往 ${pathTail(cur.target)}，可在输入框上方更换`, 'info');
      return;
    }
    setTarget(p.cwd);
  }, [setTarget]);

  const inheritCwd = useCallback((cwd) => {
    const next = cwd || '';
    if (next === state.current.target) return;
    setTarget(next);
    if (draftActive.current) toast(next ? `新对话目标已切换到 ${pathTail(next)}，草稿已保留` : '此会话没有工作目录，请为草稿选择目标', 'info');
  }, [setTarget]);

  const prepareNewChat = useCallback(() => {
    const cur = state.current;
    if (draftActive.current || !cur.projectId) return;
    const p = cur.catalog.projects.find((x) => x.id === cur.projectId);
    if (p?.cwd && !p.cwds.includes(cur.target)) setTarget(p.cwd);
  }, [setTarget]);

  const noteCreated = useCallback((summary) => {
    setOptimistic((xs) => [{ ...summary, createdAt: Date.now() }, ...xs.filter((x) => x.sessionId !== summary.sessionId)]);
    refresh();
    // JSONL 首行落盘可能晚于 POST 返回，补一次延迟刷新
    scheduleRefresh(2500);
  }, [refresh, scheduleRefresh]);

  const setDraftActive = useCallback((v) => { draftActive.current = v; }, []);

  const value = useMemo(() => ({
    catalog, catalogLoaded, catalogError, projectId, target, listSignal, optimistic,
    refresh, selectProject, setTarget, inheritCwd, prepareNewChat, noteCreated, setDraftActive,
  }), [catalog, catalogLoaded, catalogError, projectId, target, listSignal, optimistic,
    refresh, selectProject, setTarget, inheritCwd, prepareNewChat, noteCreated, setDraftActive]);

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export { ALL_PROJECTS };
