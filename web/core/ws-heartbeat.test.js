import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeartbeat } from './ws-heartbeat.js';

function harness(overrides = {}) {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const scheduler = {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const sent = [];
  let deaths = 0;
  const heartbeat = createHeartbeat({
    send: (frame) => sent.push({ at: time, ...frame }),
    onDead: () => { deaths += 1; },
    now: () => time,
    scheduler,
    ...overrides,
  });
  function advance(ms) {
    const target = time + ms;
    for (;;) {
      let dueId = null;
      let due = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (due === null || timer.at < due.at)) { dueId = id; due = timer; }
      }
      if (!due) break;
      timers.delete(dueId);
      time = due.at;
      due.fn();
    }
    time = target;
  }
  return { heartbeat, advance, sent, deaths: () => deaths, timers };
}

test('an unanswered ping with no frames calls onDead once and stops timers', () => {
  const h = harness();
  h.heartbeat.start();
  h.advance(20_000);

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'ping');
  assert.equal(h.deaths(), 1);
  assert.equal(h.timers.size, 0);

  h.advance(60_000);
  assert.equal(h.deaths(), 1);
});

test('a frame after the ping keeps the socket alive', () => {
  const h = harness();
  h.heartbeat.start();
  h.advance(5000);
  assert.equal(h.sent.length, 1);

  h.heartbeat.noteFrame();
  h.advance(6000);

  assert.equal(h.deaths(), 0);
  assert.equal(h.sent.length, 1);
});

test('a pong clears the outstanding wait without a death', () => {
  const h = harness();
  h.heartbeat.start();
  h.advance(5000);
  h.heartbeat.noteFrame();
  h.advance(10_000);
  assert.equal(h.sent.length, 2);
  assert.equal(h.deaths(), 0);

  h.heartbeat.notePong();
  h.advance(7000);

  assert.equal(h.deaths(), 0);
});

test('pause stops timers and resume restarts without a burst or immediate death', () => {
  const h = harness();
  h.heartbeat.start();
  h.advance(5000);
  assert.equal(h.sent.length, 1);

  h.heartbeat.pause();
  h.advance(60_000);
  assert.equal(h.deaths(), 0);
  assert.equal(h.sent.length, 1);

  h.heartbeat.resume();
  assert.equal(h.sent.length, 1);
  assert.equal(h.deaths(), 0);

  h.advance(5000);
  assert.equal(h.sent.length, 1);
  h.advance(5000);
  assert.equal(h.sent.length, 2);
  assert.equal(h.deaths(), 0);
});

test('stop is idempotent and silences the watchdog', () => {
  const h = harness();
  h.heartbeat.start();
  h.advance(5000);
  assert.equal(h.sent.length, 1);

  h.heartbeat.stop();
  h.heartbeat.stop();
  h.advance(60_000);

  assert.equal(h.sent.length, 1);
  assert.equal(h.deaths(), 0);
  assert.equal(h.timers.size, 0);
});

test('the default scheduler survives browser timers that reject a foreign receiver', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function (fn, ms) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = function (id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return realClearTimeout(id);
  };
  try {
    const heartbeat = createHeartbeat({ send: () => {}, onDead: () => {} });
    assert.doesNotThrow(() => heartbeat.start());
    assert.doesNotThrow(() => heartbeat.stop());
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
