import { html, useEffect, useState } from '../../vendor/preact-htm-standalone.module.js';
import { useBus } from '../../core/bus.js';
import { ws } from '../../core/ws.js';
import { STATUS_DOT, STATUS_LABEL } from '../utils.js';

export function StatusBadge({ status }) {
  if (!status) return null;
  return html`<span class="badge ${STATUS_DOT[status] || ''}"><i class="dot"></i>${STATUS_LABEL[status] || status}</span>`;
}

export function ConnBar() {
  const [st, setSt] = useState({ ...ws.state });
  const [, setTick] = useState(0);
  useBus('ws-state', (s) => setSt(s), []);
  useEffect(() => { setSt({ ...ws.state }); }, []);
  useEffect(() => {
    if (st.phase !== 'closed') return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [st.phase]);
  if (st.phase === 'open') return null;
  if (st.phase === 'connecting') return html`<div class="connbar connecting">连接中…</div>`;
  const secs = Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000));
  return html`<div class="connbar closed" onClick=${() => ws.reconnectNow()}>连接已断开，${secs}s 后重连 · 点击立即重试</div>`;
}
