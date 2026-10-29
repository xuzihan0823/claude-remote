import assert from 'node:assert/strict';
import { test } from 'node:test';

const values = new Map();
globalThis.localStorage ??= {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
const { probeBases, isRelayBase, DIRECT_GRACE_MS, PROBE_TIMEOUT_MS } = await import('./api.js');

const DIRECT_A = 'http://100.64.1.2:8787';
const DIRECT_B = 'http://192.168.1.5:8787';
const RELAY = 'https://relay.example.com/d/abc123';

function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    async advance(ms) {
      await flush();
      const target = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

/** 每个 base 一个可手动结算的假请求；记录 signal 以检查是否被中止。 */
function fakeNet() {
  const calls = new Map();
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const base = url.replace(/\/api\/health$/, '');
    const call = { signal: init.signal, ok: () => resolve(new Response('{}', { status: 200 })), status: (s) => resolve(new Response('{}', { status: s })), fail: () => reject(new TypeError('network')) };
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    calls.set(base, call);
  });
  return { calls, fetchImpl };
}

function start(bases) {
  const clock = fakeClock();
  const net = fakeNet();
  let outcome;
  const p = probeBases(bases, 'tok', { fetchImpl: net.fetchImpl, timers: clock }).then(
    (base) => { outcome = { base }; },
    (error) => { outcome = { error }; },
  );
  return { clock, net, p, get outcome() { return outcome; } };
}

test('relay 地址识别：/d/<id> 路径为 relay，其余为直连', () => {
  assert.equal(isRelayBase(RELAY), true);
  assert.equal(isRelayBase(`${RELAY}/`), true);
  assert.equal(isRelayBase(DIRECT_A), false);
  assert.equal(isRelayBase('https://relay.example.com/d/abc/extra'), false);
  assert.equal(isRelayBase('not a url'), false);
});

test('直连先成功立即采用，并中止其余探测', async () => {
  const r = start([RELAY, DIRECT_A, DIRECT_B]);
  await flush();
  r.net.calls.get(DIRECT_B).ok();
  await flush();
  assert.deepEqual(r.outcome, { base: DIRECT_B });
  assert.equal(r.net.calls.get(RELAY).signal.aborted, true);
  assert.equal(r.net.calls.get(DIRECT_A).signal.aborted, true);
});

test('relay 先成功、宽限期内直连成功 → 用直连', async () => {
  const r = start([RELAY, DIRECT_A]);
  await flush();
  r.net.calls.get(RELAY).ok();
  await r.clock.advance(DIRECT_GRACE_MS - 1);
  assert.equal(r.outcome, undefined, '宽限期内不应决定');
  r.net.calls.get(DIRECT_A).ok();
  await flush();
  assert.deepEqual(r.outcome, { base: DIRECT_A });
});

test('relay 先成功、宽限期过后直连仍未响应 → 用 relay 并中止直连', async () => {
  const r = start([DIRECT_A, RELAY]);
  await flush();
  r.net.calls.get(RELAY).ok();
  await r.clock.advance(DIRECT_GRACE_MS);
  assert.deepEqual(r.outcome, { base: RELAY });
  assert.equal(r.net.calls.get(DIRECT_A).signal.aborted, true);
});

test('relay 成功后直连全部失败 → 不等宽限期直接用 relay', async () => {
  const r = start([DIRECT_A, RELAY]);
  await flush();
  r.net.calls.get(RELAY).ok();
  await flush();
  r.net.calls.get(DIRECT_A).fail();
  await flush();
  assert.deepEqual(r.outcome, { base: RELAY });
});

test('任一 401 立即抛 unauthorized，即使 relay 已成功在等宽限期', async () => {
  const r = start([DIRECT_A, RELAY, DIRECT_B]);
  await flush();
  r.net.calls.get(RELAY).ok();
  await flush();
  r.net.calls.get(DIRECT_A).status(401);
  await flush();
  assert.equal(r.outcome.error.code, 'unauthorized');
  assert.equal(r.net.calls.get(DIRECT_B).signal.aborted, true);
});

test('全部失败抛最后一个错误；超时记为 network_timeout', async () => {
  const r = start([DIRECT_A, DIRECT_B]);
  await flush();
  r.net.calls.get(DIRECT_A).status(502);
  await flush();
  assert.equal(r.outcome, undefined);
  await r.clock.advance(PROBE_TIMEOUT_MS);
  assert.equal(r.outcome.error.code, 'network_timeout');

  const r2 = start([DIRECT_A, DIRECT_B]);
  await flush();
  r2.net.calls.get(DIRECT_B).fail();
  await flush();
  r2.net.calls.get(DIRECT_A).status(502);
  await flush();
  assert.equal(r2.outcome.error.code, 'http_502');
});

test('空候选与重复地址：空列表报 network_error，重复只探测一次', async () => {
  await assert.rejects(probeBases([], 'tok'), { code: 'network_error' });
  const r = start([DIRECT_A, `${DIRECT_A}/`, '100.64.1.2:8787']);
  await flush();
  assert.deepEqual([...r.net.calls.keys()], [DIRECT_A]);
  r.net.calls.get(DIRECT_A).ok();
  await flush();
  assert.deepEqual(r.outcome, { base: DIRECT_A });
});
