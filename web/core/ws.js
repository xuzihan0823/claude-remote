import { bus } from './bus.js';
import { wsEndpoint } from './api.js';

export const WS_PING_MS = 10_000;
export const WS_PONG_TIMEOUT_MS = 5_000;
export const WS_FAILS_BEFORE_RESELECT = 2;

// deps 供测试注入；默认用全局 WebSocket / 计时器与当前连接的 wsEndpoint()。
export function createWs({ endpoint = wsEndpoint, WebSocketImpl, timers = globalThis, random = Math.random } = {}) {
  let sock = null;
  let attempt = 0;
  let timer = null;
  let stopped = true;
  // 连续「没连上就关闭」的次数；开启 autoReselect 时达到阈值就交给 App 重选通道，期间暂停自身重试
  let failures = 0;
  let paused = false;
  let autoReselect = false;
  let pingTimer = null;
  let pongTimer = null;
  const subs = new Set(['*']);
  const state = { phase: 'closed', retryAt: 0 };

  function emitState(phase) { state.phase = phase; bus.emit('ws-state', { ...state }); }
  function send(obj) { if (sock?.readyState === 1) sock.send(JSON.stringify(obj)); }
  function clearHeartbeat() {
    timers.clearInterval(pingTimer);
    timers.clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  }
  function scheduleRetry() {
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) + random() * 400;
    state.retryAt = Date.now() + delay;
    emitState('closed');
    timers.clearTimeout(timer);
    timer = timers.setTimeout(connect, delay);
  }
  function requestReselect() {
    paused = true;
    timers.clearTimeout(timer);
    state.retryAt = 0;
    emitState('connecting');
    bus.emit('ws-reselect');
  }
  function afterFailure() {
    if (autoReselect && failures >= WS_FAILS_BEFORE_RESELECT) requestReselect();
    else scheduleRetry();
  }
  function dropSocket() {
    clearHeartbeat();
    const s = sock;
    sock = null;
    try { s?.close(); } catch { /* noop */ }
  }
  function connect() {
    if (stopped || paused) return;
    emitState('connecting');
    const Impl = WebSocketImpl || globalThis.WebSocket;
    let s;
    try { s = new Impl(endpoint()); } catch { failures += 1; afterFailure(); return; }
    sock = s;
    let opened = false;
    // 旧 daemon 不回 pong：只有本连接收到过 pong 才启用半开判定
    let pongSeen = false;
    let heardSincePing = true;
    const stale = () => sock !== s;
    const connGuard = timers.setTimeout(() => { if (!stale() && s.readyState === 0) { try { s.close(); } catch { /* noop */ } } }, 6000);
    const ping = () => {
      if (stale()) return;
      timers.clearTimeout(pongTimer);
      heardSincePing = false;
      send({ type: 'ping' });
      if (!pongSeen) return;
      pongTimer = timers.setTimeout(() => {
        if (stale() || heardSincePing) return;
        dropSocket();
        if (autoReselect) requestReselect();
        else scheduleRetry();
      }, WS_PONG_TIMEOUT_MS);
    };
    s.onopen = () => {
      if (stale()) { try { s.close(); } catch { /* noop */ } return; }
      timers.clearTimeout(connGuard);
      opened = true;
      attempt = 0;
      failures = 0;
      emitState('open');
      for (const id of subs) send({ type: 'subscribe', sessionId: id });
      ping();
      pingTimer = timers.setInterval(ping, WS_PING_MS);
      bus.emit('ws-open');
    };
    s.onmessage = (e) => {
      if (stale()) return;
      heardSincePing = true;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m?.type === 'pong') { pongSeen = true; return; }
      if (m?.type) bus.emit(`ws:${m.type}`, m);
    };
    s.onerror = () => { if (!stale()) { try { s.close(); } catch { /* noop */ } } };
    s.onclose = () => {
      timers.clearTimeout(connGuard);
      if (stale() || stopped) return;
      clearHeartbeat();
      sock = null;
      // 用着的连接突然断开多半是网络换了（关 Wi-Fi / Tailscale），立即重选通道，不等两次重连失败
      if (opened && autoReselect) { requestReselect(); return; }
      if (!opened) failures += 1;
      afterFailure();
    };
  }
  return {
    state,
    /** App 开启后，连续失败或半开时发 ws-reselect 并暂停重试，等 App 调 reconnectNow / resume / stop+start。 */
    setAutoReselect(on) { autoReselect = !!on; },
    start() {
      if (!stopped) return;
      stopped = false;
      paused = false;
      attempt = 0;
      failures = 0;
      connect();
    },
    stop() {
      stopped = true;
      paused = false;
      timers.clearTimeout(timer);
      dropSocket();
      emitState('closed');
    },
    reconnectNow() {
      if (stopped) return;
      timers.clearTimeout(timer);
      paused = false;
      attempt = 0;
      failures = 0;
      dropSocket();
      connect();
    },
    /** 重选没找到更好的地址：退出暂停，按原退避节奏继续重试当前地址。 */
    resume() {
      if (stopped || !paused) return;
      paused = false;
      failures = 0;
      scheduleRetry();
    },
    subscribe(id) { subs.add(id); send({ type: 'subscribe', sessionId: id }); },
    unsubscribe(id) { subs.delete(id); send({ type: 'unsubscribe', sessionId: id }); },
  };
}

export const ws = createWs();
