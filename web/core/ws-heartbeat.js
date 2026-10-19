export function createHeartbeat({
  send,
  onDead,
  intervalMs = 5000,
  pingEveryMs = 10000,
  timeoutMs = 5000,
  now = Date.now,
  scheduler = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  },
}) {
  let running = false;
  let paused = false;
  let timer = null;
  let lastPingAt = null;
  let pendingPingAt = null;
  let frameSincePing = false;

  function arm() {
    scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(tick, intervalMs);
  }

  function tick() {
    timer = null;
    if (!running || paused) return;
    const t = now();

    if (pendingPingAt != null) {
      if (frameSincePing) {
        pendingPingAt = null;
        frameSincePing = false;
      } else if (t - pendingPingAt > timeoutMs) {
        stop();
        onDead();
        return;
      }
    }

    if (pendingPingAt == null && (lastPingAt == null || t - lastPingAt >= pingEveryMs)) {
      lastPingAt = t;
      pendingPingAt = t;
      frameSincePing = false;
      send({ type: 'ping' });
    }
    arm();
  }

  function start() {
    running = true;
    paused = false;
    lastPingAt = null;
    pendingPingAt = null;
    frameSincePing = false;
    arm();
  }

  function stop() {
    running = false;
    paused = false;
    lastPingAt = null;
    pendingPingAt = null;
    frameSincePing = false;
    scheduler.clearTimeout(timer);
    timer = null;
  }

  function pause() {
    paused = true;
    scheduler.clearTimeout(timer);
    timer = null;
  }

  function resume() {
    if (!running) return;
    paused = false;
    lastPingAt = now();
    pendingPingAt = null;
    frameSincePing = false;
    arm();
  }

  function noteFrame() {
    if (pendingPingAt != null) frameSincePing = true;
  }

  function notePong() {
    noteFrame();
    pendingPingAt = null;
    frameSincePing = false;
  }

  return { start, stop, pause, resume, noteFrame, notePong };
}
