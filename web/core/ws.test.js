import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
const { createWs, WS_PING_MS, WS_PONG_TIMEOUT_MS } = await import('./ws.js');
const { bus } = await import('./bus.js');

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const add = (fn, ms, every) => { const id = ++seq; pending.set(id, { at: now + ms, fn, every }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else pending.delete(id);
        t.fn();
      }
      now = target;
    },
  };
}

function setup() {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    fail() { this.readyState = 3; this.onclose?.(); }
    pings() { return this.sent.filter((f) => f.type === 'ping').length; }
  }
  const timers = fakeTimers();
  const conn = createWs({ endpoint: () => 'ws://x/ws', WebSocketImpl: FakeSocket, timers, random: () => 0 });
  const events = { reselect: 0, pong: 0 };
  const offs = [bus.on('ws-reselect', () => { events.reselect += 1; }), bus.on('ws:pong', () => { events.pong += 1; })];
  const last = () => sockets[sockets.length - 1];
  return { conn, timers, sockets, last, events, dispose: () => { conn.stop(); offs.forEach((f) => f()); } };
}

test('连上后立即和每 10 秒发应用层 ping；pong 不分发给业务层', () => {
  const t = setup();
  try {
    t.conn.start();
    t.last().open();
    assert.equal(t.last().pings(), 1);
    t.timers.advance(WS_PING_MS);
    assert.equal(t.last().pings(), 2);
    t.last().receive({ type: 'pong' });
    assert.equal(t.events.pong, 0);
  } finally { t.dispose(); }
});

test('旧 daemon 从不回 pong：不启用半开判定，连接保持', () => {
  const t = setup();
  try {
    t.conn.setAutoReselect(true);
    t.conn.start();
    t.last().open();
    t.timers.advance(WS_PING_MS * 4);
    assert.equal(t.sockets.length, 1);
    assert.equal(t.last().readyState, 1);
    assert.equal(t.events.reselect, 0);
  } finally { t.dispose(); }
});

test('收到过 pong 后，ping 发出 5 秒内无任何消息 → 主动关闭并发 ws-reselect，暂停自身重试', () => {
  const t = setup();
  try {
    t.conn.setAutoReselect(true);
    t.conn.start();
    t.last().open();
    t.last().receive({ type: 'pong' });
    t.timers.advance(WS_PING_MS);
    t.timers.advance(WS_PONG_TIMEOUT_MS - 1);
    t.last().receive({ type: 'status', sessionId: 'x' });
    t.timers.advance(1);
    assert.equal(t.last().readyState, 1, '期间收到任何消息都算活着');
    t.timers.advance(WS_PING_MS - WS_PONG_TIMEOUT_MS);
    t.timers.advance(WS_PONG_TIMEOUT_MS);
    assert.equal(t.last().readyState, 3);
    assert.equal(t.events.reselect, 1);
    t.timers.advance(60_000);
    assert.equal(t.sockets.length, 1, '重选期间不自己重连');
    t.conn.reconnectNow();
    assert.equal(t.sockets.length, 2);
  } finally { t.dispose(); }
});

test('连续 2 次连接失败 → ws-reselect；resume 后按退避继续重试', () => {
  const t = setup();
  try {
    t.conn.setAutoReselect(true);
    t.conn.start();
    t.last().fail();
    assert.equal(t.events.reselect, 0, '一次失败只退避重试');
    t.timers.advance(1000);
    assert.equal(t.sockets.length, 2);
    t.last().fail();
    assert.equal(t.events.reselect, 1);
    t.timers.advance(60_000);
    assert.equal(t.sockets.length, 2);
    t.conn.resume();
    t.timers.advance(4000);
    assert.equal(t.sockets.length, 3, '继续原退避节奏');
  } finally { t.dispose(); }
});

test('已连上的连接意外断开 → 立即 ws-reselect；成功连上会清零失败计数；未开启 autoReselect（浏览器版）时只退避重试', () => {
  const t = setup();
  try {
    t.conn.setAutoReselect(true);
    t.conn.start();
    t.last().fail();
    t.timers.advance(1000);
    t.last().open();
    t.last().fail();
    assert.equal(t.events.reselect, 1, '打开后断开立即重选');
    t.conn.resume();
    t.timers.advance(1000);
    t.last().fail();
    assert.equal(t.events.reselect, 1, '打开时清零了失败计数，之后只失败了 1 次');
  } finally { t.dispose(); }

  const w = setup();
  try {
    w.conn.start();
    for (let i = 0; i < 4; i += 1) { w.last().fail(); w.timers.advance(1000 * 2 ** i); }
    assert.equal(w.events.reselect, 0);
    assert.equal(w.sockets.length, 5);
  } finally { w.dispose(); }
});
