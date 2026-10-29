import { useCallback, useEffect, useRef, useState } from 'react';
import { useBus } from '../../../web/core/bus.js';
import { EMPTY_CAPABILITIES, createCapabilitiesLoader } from '../../../web/core/effort.js';

export function useModelCapabilities({ cwd = '', sessionId = '', model = '' } = {}) {
  const [capabilities, setCapabilities] = useState(() => ({
    ...EMPTY_CAPABILITIES,
    loading: false,
    error: '',
  }));
  const loaderRef = useRef(null);
  if (!loaderRef.current) {
    loaderRef.current = createCapabilitiesLoader({ onUpdate: setCapabilities });
  }

  const reload = useCallback((opts = {}) => {
    return loaderRef.current.load({
      cwd,
      sessionId,
      model,
      refresh: Boolean(opts?.refresh),
    });
  }, [cwd, sessionId, model]);

  const applyServerCapabilities = useCallback((raw) => {
    if (raw && typeof raw === 'object') {
      loaderRef.current.applyCapabilities(raw, { cwd, sessionId, model });
    }
    return loaderRef.current.load({ cwd, sessionId, model, refresh: true });
  }, [cwd, sessionId, model]);

  useEffect(() => {
    reload();
    return () => {
      loaderRef.current?.reset();
    };
  }, [reload]);

  useBus('ws-open', () => { reload(); }, [reload]);
  useBus('devices', () => { reload(); }, [reload]);

  return {
    capabilities,
    reload,
    applyServerCapabilities,
  };
}
