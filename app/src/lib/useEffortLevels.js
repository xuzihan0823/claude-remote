import { useCallback, useEffect, useRef, useState } from 'react';
import { useBus } from '../../../web/core/bus.js';
import { fetchEffortLevels } from '../../../web/core/effort.js';

// options 为 null 表示尚未拿到（或请求失败），此时按「未确认」处理。
export function useEffortLevels({ sessionId = '', cwd = '', model = '' } = {}) {
  const [options, setOptions] = useState(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!sessionId && !cwd) { setOptions(null); return; }
    try {
      const next = await fetchEffortLevels({ sessionId, cwd, model });
      if (mine === seq.current) setOptions(next);
    } catch {
      if (mine === seq.current) setOptions(null);
    }
  }, [sessionId, cwd, model]);

  useEffect(() => {
    setOptions(null);
    reload();
  }, [reload]);
  useBus('ws-open', () => { reload(); }, [reload]);

  return { options, reload };
}
