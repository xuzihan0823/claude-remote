import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavigationContainerRefContext } from '@react-navigation/native';
import { fetchSessions, sessionCache } from '../../../web/core/api.js';
import { useBus } from '../../../web/core/bus.js';
import { createProjectSessionGroups, drawerFocus, OPTIMISTIC_TTL } from './project-session-groups.js';
import { useProjects } from './projects-context.js';

export function useProjectSessionGroups(navigationState) {
  const { catalog, catalogLoaded, listSignal, optimistic } = useProjects();
  const controller = useRef(null);
  const signal = useRef(listSignal);
  const [snapshot, setSnapshot] = useState({ groups: [], rows: [], loading: false });
  const [cacheVersion, setCacheVersion] = useState(0);
  const navigation = useContext(NavigationContainerRefContext);
  const [focus, setFocus] = useState(() => drawerFocus(navigationState));

  useEffect(() => {
    const syncFocus = () => {
      const next = drawerFocus(navigation?.getRootState() || navigationState);
      setFocus((current) => current.name === next.name && current.sessionId === next.sessionId ? current : next);
    };
    const unsubscribe = navigation?.addListener('state', syncFocus);
    syncFocus();
    return unsubscribe;
  }, [navigation, navigationState]);

  useEffect(() => {
    controller.current = createProjectSessionGroups(fetchSessions, setSnapshot);
    return () => { controller.current.dispose(); controller.current = null; };
  }, []);

  useEffect(() => {
    controller.current.update({
      catalog, loaded: catalogLoaded, optimistic,
      focus: { ...focus, meta: sessionCache.get(focus.sessionId) || optimistic.find((s) => s.sessionId === focus.sessionId) },
      refresh: signal.current !== listSignal,
    });
    signal.current = listSignal;
  }, [catalog, catalogLoaded, listSignal, optimistic, focus.name, focus.sessionId, cacheVersion]);

  useEffect(() => {
    const expires = optimistic.map((s) => s.createdAt + OPTIMISTIC_TTL).filter((t) => t > Date.now());
    if (!expires.length) return;
    const timer = setTimeout(() => {
      controller.current?.expireOptimistic();
      setCacheVersion((v) => v + 1);
    }, Math.max(1, Math.min(...expires) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [optimistic, cacheVersion]);

  useBus('sessions-cached', () => setCacheVersion((v) => v + 1), []);
  useBus('ws:status', ({ sessionId, status }) => controller.current?.setStatus(sessionId, status), []);

  const toggle = useCallback((id) => controller.current?.toggle(id), []);
  const retry = useCallback((id) => controller.current?.retry(id), []);
  const loadMore = useCallback((id) => controller.current?.loadMore(id), []);
  return { ...snapshot, selectedSessionId: focus.sessionId, toggle, retry, loadMore };
}
