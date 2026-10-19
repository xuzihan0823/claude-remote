import { bus } from './bus.js';
import { wsEndpoint } from './api.js';
import { createHeartbeat } from './ws-heartbeat.js';

export const ws = (() => {
  let sock = null;
  let attempt = 0;
  let timer = null;
  let stopped = true;
  const subs = new Set(['*']);
  const state = { phase: 'closed', retryAt: 0 };

  function emitState(phase) { state.phase = phase; bus.emit('ws-state', { ...state }); }
  function send(obj) { if (sock?.readyState === 1) sock.send(JSON.stringify(obj)); }
  function scheduleRetry() {
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 400;
    state.retryAt = Date.now() + delay;
    emitState('closed');
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
  }
  function connect() {
    if (stopped) return;
    heartbeat.stop();
    emitState('connecting');
    let s;
    try { s = new WebSocket(wsEndpoint()); } catch { scheduleRetry(); return; }
    sock = s;
    const stale = () => sock !== s;
    const connGuard = setTimeout(() => { if (!stale() && s.readyState === 0) { try { s.close(); } catch { /* noop */ } } }, 6000);
    s.onopen = () => {
      if (stale()) { try { s.close(); } catch { /* noop */ } return; }
      clearTimeout(connGuard);
      attempt = 0;
      emitState('open');
      for (const id of subs) send({ type: 'subscribe', sessionId: id });
      heartbeat.start();
      bus.emit('ws-open');
    };
    s.onmessage = (e) => {
      if (stale()) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      heartbeat.noteFrame();
      if (m?.type === 'pong') heartbeat.notePong();
      if (m?.type) bus.emit(`ws:${m.type}`, m);
    };
    s.onerror = () => { if (!stale()) { try { s.close(); } catch { /* noop */ } } };
    s.onclose = () => {
      clearTimeout(connGuard);
      if (stale()) return;
      heartbeat.stop();
      if (stopped) return;
      scheduleRetry();
    };
  }
  function reconnectNow() {
    if (stopped) return;
    clearTimeout(timer);
    attempt = 0;
    const s = sock;
    sock = null;
    try { s?.close(); } catch { /* noop */ }
    connect();
  }
  const heartbeat = createHeartbeat({
    send: (message) => send(message),
    onDead: () => reconnectNow(),
  });
  return {
    state,
    start() { if (!stopped) return; stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      heartbeat.stop();
      const s = sock;
      sock = null;
      try { s?.close(); } catch { /* noop */ }
      emitState('closed');
    },
    reconnectNow,
    subscribe(id) { subs.add(id); send({ type: 'subscribe', sessionId: id }); },
    unsubscribe(id) { subs.delete(id); send({ type: 'unsubscribe', sessionId: id }); },
    pauseHeartbeat() { heartbeat.pause(); },
    resumeHeartbeat() { heartbeat.resume(); },
  };
})();
