// relay 集成测试：真实 relay（端口 0）+ 假 agent（直接用 protocol 模块）+ 真实 HTTP/WS 客户端。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { CreditSender, DataType, INITIAL_WINDOW, deriveDeviceId, generateDeviceKey } from "../src/protocol.js";
import { CLOSE_REPLACED } from "../src/server.js";
import {
  FakeAgent,
  ID_A,
  KEY_A,
  SECRET,
  closeEvent,
  delay,
  nextMessage,
  request,
  startTestRelay,
  until,
  wsConnect,
} from "./helpers.js";

function respond(agent: FakeAgent, sid: number, status = 200, body = ""): void {
  agent.send({ t: "head", sid, status, headers: { "content-type": "text/plain" } });
  if (body !== "") agent.sendData(DataType.HttpBody, sid, body);
  agent.send({ t: "end", sid });
}

function opens(agent: FakeAgent): number[] {
  return agent.events.flatMap((e) => (e.kind === "control" && e.frame.t === "open" ? [e.frame.sid] : []));
}

test("healthz 与未知路径", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const health = await request(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true, version: "test" });
  for (const path of ["/", "/agent", "/d/", "/d/short/api", `/d/${ID_A}x/api`, `/x/d/${ID_A}/api`]) {
    const res = await request(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.json(), { error: "not_found" });
  }
});

test("HTTP 转发：去前缀、query 原样、hop-by-hop 头不转发、响应透明", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.serveEcho();

  const res = await request(`${base}/d/${ID_A}/api/sessions?token=abc&q=%E4%B8%AD+x&empty=`, {
    headers: {
      Authorization: "Bearer phone-token",
      "X-Custom": "1",
      Connection: "keep-alive, X-Hop",
      "X-Hop": "drop",
      "Keep-Alive": "timeout=5",
      "X-Forwarded-For": "198.51.100.7, 10.0.0.1",
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-echo"], "1");
  const echo = res.json() as { method: string; path: string; headers: Record<string, string>; remote: string };
  assert.equal(echo.method, "GET");
  assert.equal(echo.path, "/api/sessions?token=abc&q=%E4%B8%AD+x&empty=");
  assert.equal(echo.headers["authorization"], "Bearer phone-token");
  assert.equal(echo.headers["x-custom"], "1");
  for (const hop of ["connection", "x-hop", "keep-alive"]) assert.equal(echo.headers[hop], undefined, hop);
  assert.equal(echo.remote, "198.51.100.7");

  const post = await request(`${base}/d/${ID_A}/api/x`, { method: "POST", body: "hello body" });
  const postEcho = post.json() as { method: string; path: string; body: string; remote: string };
  assert.deepEqual([postEcho.method, postEcho.path, postEcho.body, postEcho.remote], ["POST", "/api/x", "hello body", "127.0.0.1"]);

  assert.equal((await request(`${base}/d/${ID_A}`)).json().path, "/");
  assert.equal((await request(`${base}/d/${ID_A}?a=1`)).json().path, "/?a=1");
});

test("设备离线：HTTP 503 device_offline，WS 以 503 拒绝", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const res = await request(`${base}/d/${ID_A}/api/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(res.json(), { error: "device_offline" });
  await assert.rejects(wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws?token=x`), { status: 503 });
});

test("agent 接入鉴权：密钥错 401，ID 与私钥不符 403，格式错 400，均不能抢占已在线设备", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const owner = await FakeAgent.connect(relay.port, KEY_A);
  owner.serveEcho();

  await assert.rejects(FakeAgent.connect(relay.port, KEY_A, { secret: `${SECRET}x` }), { status: 401 });
  await assert.rejects(FakeAgent.connect(relay.port, KEY_A, { secret: "" }), { status: 401 });
  // 攻击者有 relay 密钥但没有 ID_A 的私钥
  await assert.rejects(FakeAgent.connect(relay.port, generateDeviceKey(), { id: ID_A }), (error: { status: number; body: string }) => {
    assert.equal(error.status, 403);
    assert.deepEqual(JSON.parse(error.body), { error: "device_key_mismatch" });
    return true;
  });
  await assert.rejects(FakeAgent.connect(relay.port, KEY_A, { id: deriveDeviceId(generateDeviceKey()) }), { status: 403 });
  await assert.rejects(FakeAgent.connect(relay.port, "short", { id: deriveDeviceId("short") }), { status: 400 });

  const res = await request(`${base}/d/${ID_A}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(opens(owner).length, 1);
});

test("relay 重启后同一私钥仍接入同一设备 ID", async () => {
  const first = await startTestRelay();
  const agent1 = await FakeAgent.connect(first.relay.port, KEY_A);
  agent1.serveEcho();
  assert.equal((await request(`${first.base}/d/${ID_A}/api/a`)).status, 200);
  await first.relay.close();
  await agent1.closed;

  const second = await startTestRelay();
  try {
    assert.equal((await request(`${second.base}/d/${ID_A}/api/a`)).status, 503);
    const agent2 = await FakeAgent.connect(second.relay.port, KEY_A);
    agent2.serveEcho();
    const res = await request(`${second.base}/d/${ID_A}/api/b`);
    assert.equal(res.status, 200);
    assert.equal(res.json().path, "/api/b");
  } finally {
    await second.relay.close();
  }
});

test("同 ID 新连接替换旧连接：旧连接 4001，旧连接上的请求得到错误，新请求走新连接", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const old = await FakeAgent.connect(relay.port, KEY_A);
  const pending = request(`${base}/d/${ID_A}/api/slow`);
  await old.waitControl("end");

  const fresh = await FakeAgent.connect(relay.port, KEY_A);
  fresh.serveEcho();
  assert.equal((await old.closed).code, CLOSE_REPLACED);
  const stale = await pending;
  assert.equal(stale.status, 502);
  assert.deepEqual(stale.json(), { error: "device_disconnected" });

  const res = await request(`${base}/d/${ID_A}/api/next`);
  assert.equal(res.status, 200);
  assert.equal(opens(fresh).length, 1);
});

test("每设备并发流上限：超出返回 503 too_many_streams，释放后恢复", async (t) => {
  const { relay, base } = await startTestRelay({ maxStreams: 2 });
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  const p1 = request(`${base}/d/${ID_A}/api/1`);
  const p2 = request(`${base}/d/${ID_A}/api/2`);
  await until(() => opens(agent).length === 2);

  const over = await request(`${base}/d/${ID_A}/api/3`);
  assert.equal(over.status, 503);
  assert.deepEqual(over.json(), { error: "too_many_streams" });
  await assert.rejects(wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws`), { status: 503 });
  assert.equal(opens(agent).length, 2);

  const [sid1, sid2] = opens(agent) as [number, number];
  respond(agent, sid1, 200, "one");
  assert.equal((await p1).body.toString(), "one");
  const p4 = request(`${base}/d/${ID_A}/api/4`);
  await until(() => opens(agent).length === 3);
  respond(agent, sid2);
  respond(agent, opens(agent)[2] as number, 201);
  assert.equal((await p2).status, 200);
  assert.equal((await p4).status, 201);
});

test("请求体上限：Content-Length 预检 413，流式超限 413 并 reset agent 侧", async (t) => {
  const { relay, base } = await startTestRelay({ maxBodyBytes: 1000 });
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);

  const declared = await request(`${base}/d/${ID_A}/api/upload`, { method: "POST", body: "x".repeat(1001) });
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.json(), { error: "body_too_large" });
  assert.equal(opens(agent).length, 0, "预检拒绝不应打开流");

  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/d/${ID_A}/api/upload`, { method: "POST", agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => {});
    req.write("a".repeat(600));
    agent
      .waitFor((e) => e.kind === "data")
      .then(() => req.write("b".repeat(600)))
      .catch(reject);
  });
  assert.equal(status, 413);
  const sid = opens(agent)[0] as number;
  assert.equal((await agent.waitControl("reset", sid)).reason, "body_too_large");
  assert.ok(agent.bodyBytes(sid) <= 1000);
});

test("等 head 超时返回 504 并 reset agent 侧", async (t) => {
  const { relay, base } = await startTestRelay({ timings: { headTimeoutMs: 100 } });
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  const started = Date.now();
  const res = await request(`${base}/d/${ID_A}/api/hang`);
  assert.equal(res.status, 504);
  assert.deepEqual(res.json(), { error: "upstream_timeout" });
  assert.ok(Date.now() - started >= 90);
  const sid = opens(agent)[0] as number;
  assert.equal((await agent.waitControl("reset", sid)).reason, "head_timeout");
});

test("HTTP 流空闲超时：响应中途停滞则断开并 reset agent 侧", async (t) => {
  const { relay, base } = await startTestRelay({ timings: { idleTimeoutMs: 150 } });
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.on((e) => {
    if (e.kind === "control" && e.frame.t === "end") {
      agent.send({ t: "head", sid: e.frame.sid, status: 200, headers: {} });
      agent.sendData(DataType.HttpBody, e.frame.sid, "partial");
    }
  });
  const outcome = await new Promise<string>((resolve) => {
    const req = httpRequest(`${base}/d/${ID_A}/api/stream`, { agent: false }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.complete ? "complete" : "aborted"));
      res.on("error", () => resolve("aborted"));
      res.on("close", () => resolve(res.complete ? "complete" : "aborted"));
    });
    req.on("error", () => resolve("aborted"));
    req.end();
  });
  assert.equal(outcome, "aborted");
  const sid = opens(agent)[0] as number;
  assert.equal((await agent.waitControl("reset", sid)).reason, "idle_timeout");
});

test("流控：agent 不回 credit 时 relay 对单流最多发出一个窗口，且不阻塞同连接其他流", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.autoCredit = false;
  agent.serveEcho();

  const total = 1024 * 1024;
  const upload = request(`${base}/d/${ID_A}/api/upload`, { method: "POST", body: Buffer.alloc(total, 7) });
  await until(() => opens(agent).length === 1);
  const sid = opens(agent)[0] as number;
  await until(() => agent.bodyBytes(sid) === INITIAL_WINDOW);
  await delay(200);
  assert.equal(agent.bodyBytes(sid), INITIAL_WINDOW, "没有 credit 不能再多发");

  // 慢流卡住时，同一 agent 上的其他请求照常完成
  const other = await request(`${base}/d/${ID_A}/api/other`);
  assert.equal(other.status, 200);
  assert.equal(agent.bodyBytes(sid), INITIAL_WINDOW);

  agent.send({ t: "credit", sid, bytes: INITIAL_WINDOW });
  await until(() => agent.bodyBytes(sid) === 2 * INITIAL_WINDOW);
  await delay(100);
  assert.equal(agent.bodyBytes(sid), 2 * INITIAL_WINDOW);

  agent.autoCredit = true;
  agent.send({ t: "credit", sid, bytes: 2 * INITIAL_WINDOW });
  const res = await upload;
  assert.equal(res.status, 200);
  assert.equal((res.json() as { body: string }).body.length, total);
});

test("流控：relay 在手机消费后回 credit，大响应按窗口完整送达", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  const payload = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

  agent.on((e) => {
    if (e.kind !== "control" || e.frame.t !== "end") return;
    const sid = e.frame.sid;
    const sender = new CreditSender({ send: (type, chunk) => agent.sendData(type, sid, chunk), resume: pump });
    agent.on((ev) => {
      if (ev.kind === "control" && ev.frame.t === "credit" && ev.frame.sid === sid) sender.credit(ev.frame.bytes);
    });
    agent.send({ t: "head", sid, status: 200, headers: { "content-length": String(payload.length) } });
    let offset = 0;
    function pump(): void {
      while (offset < payload.length) {
        const chunk = payload.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        if (!sender.push(DataType.HttpBody, chunk)) return;
      }
      sender.afterFlush(() => agent.send({ t: "end", sid }));
    }
    pump();
  });

  const res = await request(`${base}/d/${ID_A}/api/big`);
  assert.equal(res.status, 200);
  assert.equal(createHash("sha256").update(res.body).digest("hex"), createHash("sha256").update(payload).digest("hex"));
});

test("流控：agent 越过窗口发送视为协议错误，该流被 reset", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.on((e) => {
    if (e.kind !== "control" || e.frame.t !== "end") return;
    agent.send({ t: "head", sid: e.frame.sid, status: 200, headers: {} });
    // 不等 credit 连发 32 MiB；手机不读响应，本机 socket 缓冲填满后 relay 收不到下游 drain
    for (let i = 0; i < 128; i++) agent.sendData(DataType.HttpBody, e.frame.sid, Buffer.alloc(INITIAL_WINDOW));
  });
  const req = httpRequest(`${base}/d/${ID_A}/api/flood`, { agent: false }, (res) => res.pause());
  req.on("error", () => {});
  req.end();
  await until(() => opens(agent).length === 1);
  const sid = opens(agent)[0] as number;
  assert.equal((await agent.waitControl("reset", sid)).reason, "protocol_error");
  req.destroy();
});

test("WS 转发：去前缀与 query、双向文本/二进制透传、关闭码双向传递", async (t) => {
  const { relay } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.on((e) => {
    if (e.kind === "control" && e.frame.t === "open" && e.frame.kind === "ws") agent.send({ t: "accept", sid: e.frame.sid });
  });

  const phone = await wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws?token=ws-token`);
  const open = await agent.waitControl("open");
  assert.equal(open.kind, "ws");
  assert.equal(open.path, "/ws?token=ws-token");
  for (const name of Object.keys(open.headers)) {
    assert.ok(!name.startsWith("sec-websocket-") && name !== "upgrade" && name !== "connection", name);
  }
  const sid = open.sid;

  phone.send("hello");
  const text = await agent.waitFor((e) => e.kind === "data" && e.frame.sid === sid);
  assert.ok(text.kind === "data");
  assert.equal(text.frame.type, DataType.WsText);
  assert.equal(text.frame.payload.toString(), "hello");

  phone.send(Buffer.from([1, 2, 3]));
  const bin = await agent.waitFor((e) => e.kind === "data" && e.frame.type === DataType.WsBinary);
  assert.ok(bin.kind === "data");
  assert.deepEqual([...bin.frame.payload], [1, 2, 3]);

  const fromDaemon = nextMessage(phone);
  agent.sendData(DataType.WsText, sid, "from-daemon");
  const m1 = await fromDaemon;
  assert.deepEqual([m1.isBinary, m1.data.toString()], [false, "from-daemon"]);
  assert.equal((await agent.waitControl("credit", sid)).bytes, "from-daemon".length);

  const binMsg = nextMessage(phone);
  agent.sendData(DataType.WsBinary, sid, Buffer.from([9, 8]));
  const m2 = await binMsg;
  assert.deepEqual([m2.isBinary, [...m2.data]], [true, [9, 8]]);

  // 空消息照常送达，且 relay 不回 bytes:0 的 credit（协议要求 bytes ≥ 1，FakeAgent 收到非法帧会抛错）
  const emptyMsg = nextMessage(phone);
  agent.sendData(DataType.WsText, sid, "");
  assert.equal((await emptyMsg).data.length, 0);
  const afterEmpty = nextMessage(phone);
  agent.sendData(DataType.WsText, sid, "z");
  await afterEmpty;
  await agent.waitFor((e) => e.kind === "control" && e.frame.t === "credit" && e.frame.sid === sid && e.frame.bytes === 1);

  const closed = closeEvent(phone);
  agent.send({ t: "wsclose", sid, code: 4000, reason: "bye" });
  assert.deepEqual(await closed, { code: 4000, reason: "bye" });

  const phone2 = await wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws?token=ws-token`);
  const sid2 = opens(agent)[1] as number;
  phone2.close(4002, "client bye");
  const wsclose = await agent.waitControl("wsclose", sid2);
  assert.deepEqual([wsclose.code, wsclose.reason], [4002, "client bye"]);
});

test("WS 被 daemon 拒绝时以对应状态码拒绝手机 upgrade；非 /ws 路径 404", async (t) => {
  const { relay } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.on((e) => {
    if (e.kind === "control" && e.frame.t === "open") agent.send({ t: "head", sid: e.frame.sid, status: 401, headers: {} });
  });
  await assert.rejects(wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws?token=bad`), { status: 401 });
  await assert.rejects(wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/other`), { status: 404 });
  assert.equal(opens(agent).length, 1);
});

test("agent 心跳：不回 pong 的连接在两个周期后断开并清理流，正常连接保持", async (t) => {
  const { relay, base } = await startTestRelay({ timings: { heartbeatMs: 40 } });
  t.after(() => relay.close());
  const keyB = generateDeviceKey();
  const idB = deriveDeviceId(keyB);
  const healthy = await FakeAgent.connect(relay.port, KEY_A);
  healthy.serveEcho();
  const silent = await FakeAgent.connect(relay.port, keyB, { id: idB });
  t.after(() => silent.ws.terminate());
  const pending = request(`${base}/d/${idB}/api/hang`);
  await silent.waitControl("end");
  silent.ws.pause();

  const res = await pending;
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: "device_disconnected" });
  assert.equal((await request(`${base}/d/${idB}/api/x`)).status, 503);

  await delay(200);
  assert.equal((await request(`${base}/d/${ID_A}/api/x`)).status, 200);
});

test("agent 发非法帧：关闭连接（1008）并让进行中请求得到错误；未知 sid 的帧被忽略", async (t) => {
  const { relay, base } = await startTestRelay();
  t.after(() => relay.close());
  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.send({ t: "credit", sid: 999, bytes: 10 });
  agent.send({ t: "end", sid: 12345 });
  const pending = request(`${base}/d/${ID_A}/api/x`);
  await agent.waitControl("end");
  agent.ws.send("{not json");
  assert.equal((await agent.closed).code, 1008);
  assert.equal((await pending).status, 502);
});

test("日志只含设备 ID、方法、去 query 的路径、状态码，不含 query、请求头、请求体与密钥", async (t) => {
  const { relay, base, logs } = await startTestRelay();
  t.after(() => relay.close());
  const offline = await request(`${base}/d/${ID_A}/api/health?token=OFFLINE-SECRET`);
  assert.equal(offline.status, 503);

  const agent = await FakeAgent.connect(relay.port, KEY_A);
  agent.serveEcho();
  agent.on((e) => {
    if (e.kind === "control" && e.frame.t === "open" && e.frame.kind === "ws") agent.send({ t: "accept", sid: e.frame.sid });
  });
  await request(`${base}/d/${ID_A}/api/sessions?token=QUERY-SECRET`, {
    method: "POST",
    headers: { Authorization: "Bearer HEADER-SECRET", Cookie: "c=COOKIE-SECRET" },
    body: "BODY-SECRET",
  });
  const phone = await wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID_A}/ws?token=WS-SECRET`);
  const closed = closeEvent(phone);
  phone.close(1000);
  await agent.waitControl("wsclose");
  await closed;
  await until(() => logs.some((l) => l.includes(" WS /ws ")));

  const all = logs.join("\n");
  for (const secret of ["OFFLINE-SECRET", "QUERY-SECRET", "HEADER-SECRET", "COOKIE-SECRET", "BODY-SECRET", "WS-SECRET", SECRET, KEY_A, "?"]) {
    assert.ok(!all.includes(secret), `日志泄露 ${secret}:\n${all}`);
  }
  assert.match(all, new RegExp(`${ID_A} GET /api/health 503 \\d+ms`));
  assert.match(all, new RegExp(`${ID_A} POST /api/sessions 200 \\d+ms`));
  assert.match(all, new RegExp(`${ID_A} WS /ws 101 \\d+ms`));
});
