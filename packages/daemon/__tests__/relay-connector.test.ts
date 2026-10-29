// relay connector 集成测试：真实 relay（packages/relay）+ 真实 DaemonServer + connector，
// 手机侧用普通 HTTP / WS 客户端经 relay 访问 /d/<deviceId>/*。

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { InteractionManager, InteractionStore } from "@claude-remote/interactions";
import { startRelay, type RelayHandle } from "@claude-remote/relay";
import { deriveDeviceId, generateDeviceKey } from "@claude-remote/relay/protocol";
import { WebSocket, WebSocketServer } from "ws";

import type { DaemonConfig, RelaySettings } from "../src/config.js";
import { looksProxied } from "../src/pair.js";
import { RelayConnector, forwardHeaders, type ConnectorTimings } from "../src/relay/connector.js";
import { ApprovalBridge, TurnRunner, type ActivityGate } from "../src/run/index.js";
import { DaemonServer } from "../src/server.js";
import { ActivityTracker } from "../src/watch/activity.js";
import { SessionWatcher } from "../src/watch/watcher.js";

const TOKEN = "relay-it-token";
const SECRET = "relay-it-secret-0123456789-abcdefghijkl";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ID = deriveDeviceId(KEY);
const FAST: Partial<ConnectorTimings> = { backoffMinMs: 40, backoffMaxMs: 200, authBackoffMaxMs: 2_000 };

// -- 装配 ---------------------------------------------------------------------

interface Daemon {
  server: DaemonServer;
  port: number;
  projectsDir: string;
  uploadsDir: string;
  dispose(): Promise<void>;
}

async function startDaemon(relayStatus?: () => ReturnType<RelayConnector["status"]>): Promise<Daemon> {
  const root = await mkdtemp(join(tmpdir(), "claude-remote-relay-it-"));
  const projectsDir = join(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  const config: DaemonConfig = {
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    projectsDir,
    uploadsDir: join(root, "uploads"),
    cooldownMs: 120_000,
    interactionsDbPath: ":memory:",
    permissionTimeoutMs: 300_000,
  };
  const store = new InteractionStore(":memory:");
  const manager = new InteractionManager(store, { defaultTtlMs: 300_000 });
  const watcher = new SessionWatcher({ projectsDir });
  const tracker = new ActivityTracker({ cooldownMs: 120_000 });
  const gate: ActivityGate = {
    isIdle: (id) => tracker.getStatus(id) === "idle",
    beginRun: (id) => tracker.beginRun(id),
    endRun: (id) => tracker.endRun(id),
  };
  let server: DaemonServer;
  const approvals = new ApprovalBridge({ manager, onEvent: (event) => server.handleApprovalEvent(event) });
  const runner = new TurnRunner({ gate, permissions: approvals });
  server = new DaemonServer({
    config, watcher, tracker, runner, approvals,
    notifier: async () => {},
    version: "0.1.0-test",
    claudeCliVersion: () => "test",
    modelCatalog: async () => ({ models: [] }),
    ...(relayStatus === undefined ? {} : { relayStatus }),
  });
  await server.listen();
  return {
    server,
    port: server.address().port,
    projectsDir,
    uploadsDir: config.uploadsDir,
    dispose: async () => {
      await server.close();
      watcher.close();
      tracker.dispose();
      manager.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function launchRelay(port = 0): Promise<RelayHandle> {
  return startRelay({
    secret: SECRET, host: "127.0.0.1", port, maxStreams: 64, maxBodyBytes: 25 * 1024 * 1024, log: () => {},
  });
}

function settingsFor(relayPort: number, overrides: Partial<RelaySettings> = {}): RelaySettings {
  return { url: `http://127.0.0.1:${relayPort}`, secret: SECRET, deviceId: ID, deviceKey: KEY, ...overrides };
}

async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until timed out");
    await delay(10);
  }
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: opts.method ?? "GET", headers: opts.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const json = (r: HttpResult): Record<string, unknown> => JSON.parse(r.body.toString()) as Record<string, unknown>;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const bearer = { Authorization: `Bearer ${TOKEN}` };

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      reject(Object.assign(new Error(`ws rejected ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.once("error", reject);
  });
}

/** 统计 connector 发起的 relay 连接次数。 */
function countingWebSocket(): { Impl: typeof WebSocket; count: () => number } {
  let n = 0;
  class Counting extends WebSocket {
    constructor(address: string | URL, options?: WebSocket.ClientOptions) {
      super(address, options);
      if (String(address).endsWith("/agent")) n += 1;
    }
  }
  return { Impl: Counting as unknown as typeof WebSocket, count: () => n };
}

// -- 共享环境：relay + daemon + connector --------------------------------------

let relay: RelayHandle;
let daemon: Daemon;
let connector: RelayConnector;
let phoneBase: string;

before(async () => {
  relay = await launchRelay();
  connector = new RelayConnector({ settings: settingsFor(relay.port), timings: FAST, log: () => {} });
  daemon = await startDaemon(() => connector.status());
  connector.start(daemon.server.address());
  phoneBase = `http://127.0.0.1:${relay.port}/d/${ID}`;
  await until(() => connector.status().state === "connected");
});

after(async () => {
  await connector.stop();
  await daemon.dispose();
  await relay.close();
});

test("经 relay：带 token 200、无 token 401；状态与 base 正确", async () => {
  const ok = await request(`${phoneBase}/api/health`, { headers: bearer });
  assert.equal(ok.status, 200);
  assert.equal(json(ok).ok, true);
  const anon = await request(`${phoneBase}/api/health`);
  assert.equal(anon.status, 401);
  assert.deepEqual(json(anon), { error: "unauthorized" });

  const status = connector.status();
  assert.equal(status.state, "connected");
  assert.equal(status.base, `http://127.0.0.1:${relay.port}/d/${ID}`);
  assert.equal(status.error, undefined);
});

test("connect-info 与 pairInfo：relay base 排在直连地址之后", async () => {
  const res = await request(`${phoneBase}/api/connect-info`, { headers: bearer });
  assert.equal(res.status, 200);
  const info = json(res) as { bases: string[]; relay: { state: string; base: string } };
  assert.equal(info.relay.state, "connected");
  assert.equal(info.bases.at(-1), phoneBase);
  assert.equal(info.bases.indexOf(phoneBase), info.bases.length - 1);
  assert.equal(daemon.server.pairInfo.bases.at(-1), phoneBase);
});

test("配对端点经 relay 一律 403（含 ./ 变体），本机直连仍可用", async () => {
  for (const path of ["/api/pair-info", "/api/pair-qr.svg", "/api/pair-info?x=1", "/api/./pair-info", "/api/%2e/pair-qr.svg"]) {
    const res = await request(`${phoneBase}${path}`, { headers: bearer });
    assert.equal(res.status, 403, path);
    assert.deepEqual(json(res), { error: "loopback_only" }, path);
    // connector 自己回的 403 不带 daemon /api/* 的 CORS 头：证明请求没有进 daemon
    assert.equal(res.headers["access-control-allow-origin"], undefined, path);
    assert.equal(res.body.toString().includes(TOKEN), false);
  }
  const direct = await request(`http://127.0.0.1:${daemon.port}/api/pair-info`);
  assert.equal(direct.status, 200);
});

test("回放请求带转发头：Host 改本机，X-Forwarded-* 覆盖手机伪造值，触发 looksProxied", () => {
  const headers = forwardHeaders(
    {
      host: "relay.example.com",
      "x-forwarded-for": "6.6.6.6",
      authorization: "Bearer t",
      connection: "keep-alive, x-secret",
      "x-secret": "1",
      "sec-websocket-key": "abc",
    },
    "1.2.3.4",
    { host: "127.0.0.1", port: 8787 },
    { host: "relay.example.com:8443", proto: "https" },
  );
  assert.deepEqual(headers, {
    authorization: "Bearer t",
    host: "127.0.0.1:8787",
    "x-forwarded-for": "1.2.3.4",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "relay.example.com:8443",
  });
  assert.equal(looksProxied(headers), true);
});

test("上传 1 MiB 附件：请求体经流控完整到达 daemon 并落盘", async () => {
  const body = randomBytes(1024 * 1024);
  const res = await request(`${phoneBase}/api/upload?filename=photo.bin`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/octet-stream" },
    body,
  });
  assert.equal(res.status, 200, res.body.toString());
  const saved = json(res) as { path: string; sizeBytes: number; name: string };
  assert.equal(saved.sizeBytes, body.length);
  assert.equal(saved.name, "photo.bin");
  assert.ok(saved.path.startsWith(daemon.uploadsDir));
  assert.equal(sha(await readFile(saved.path)), sha(body));
});

test("POST JSON：请求体决定 daemon 的响应（400 vs 404）", async () => {
  const bad = await request(`${phoneBase}/api/interactions/nope/decision`, {
    method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: Buffer.from("not json"),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(json(bad), { error: "invalid_json" });
  const good = await request(`${phoneBase}/api/interactions/nope/decision`, {
    method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: Buffer.from('{"type":"allow_once"}'),
  });
  assert.equal(good.status, 404);
});

test("大响应（1.5 MiB 会话正文）经流控完整到达", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const project = join(daemon.projectsDir, "large-response");
  const text = randomBytes(768 * 1024).toString("hex");
  await mkdir(project);
  await writeFile(join(project, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user", uuid: "large-u1", parentUuid: null, sessionId, cwd: "/tmp/large-response",
    message: { role: "user", content: text },
  })}\n`);
  try {
    const res = await request(`${phoneBase}/api/sessions/${sessionId}/messages`, { headers: bearer });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString()) as { messages: Array<{ text: string }> };
    assert.equal(body.messages.length, 1);
    assert.equal(sha(Buffer.from(body.messages[0]!.text)), sha(Buffer.from(text)));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("WS：经 relay 收发 ping/pong；token 错误时 daemon 的 401 原样返回", async () => {
  const ws = await wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID}/ws?token=${encodeURIComponent(TOKEN)}`);
  const reply = new Promise<string>((resolve) => ws.once("message", (data) => resolve(String(data))));
  ws.send(JSON.stringify({ type: "ping" }));
  assert.deepEqual(JSON.parse(await reply), { type: "pong" });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  ws.close(1000);
  assert.equal(await closed, 1000);

  await assert.rejects(
    wsConnect(`ws://127.0.0.1:${relay.port}/d/${ID}/ws?token=wrong`),
    (error: Error & { status?: number }) => error.status === 401,
  );
});

test("relay 重启后 connector 自动重连", async () => {
  const port = relay.port;
  await relay.close();
  await until(() => connector.status().state !== "connected");
  relay = await launchRelay(port);
  await until(() => connector.status().state === "connected");
  const res = await request(`${phoneBase}/api/health`, { headers: bearer });
  assert.equal(res.status, 200);
});

// -- 独立 connector：错误配置、替换、心跳、stop ---------------------------------

test("错误密钥：state=error/auth，按长退避重试而不是狂打", async (t) => {
  const counter = countingWebSocket();
  const bad = new RelayConnector({
    settings: settingsFor(relay.port, { secret: "x".repeat(40) }),
    timings: { backoffMinMs: 20, backoffMaxMs: 20, authBackoffMaxMs: 160 },
    WebSocket: counter.Impl,
    random: () => 1,
    log: () => {},
  });
  t.after(() => bad.stop());
  bad.start({ host: "127.0.0.1", port: daemon.port });
  await until(() => bad.status().state === "error");
  assert.equal(bad.status().error, "auth");
  await delay(1200);
  // 20/40/80/160/160… ms：1.2 秒内约 8~9 次；若退化为普通 20ms 上限会有 40 次以上
  assert.ok(counter.count() >= 4 && counter.count() <= 12, `attempts: ${counter.count()}`);
});

test("设备 ID 与私钥不匹配：state=error/device_key_mismatch", async (t) => {
  const bad = new RelayConnector({
    settings: settingsFor(relay.port, { deviceId: deriveDeviceId(generateDeviceKey()) }),
    timings: FAST,
    log: () => {},
  });
  t.after(() => bad.stop());
  bad.start({ host: "127.0.0.1", port: daemon.port });
  await until(() => bad.status().state === "error");
  assert.equal(bad.status().error, "device_key_mismatch");
});

test("relay 不可达：state=error/unreachable", async (t) => {
  const probe = await launchRelay();
  const deadPort = probe.port;
  await probe.close();
  const bad = new RelayConnector({ settings: settingsFor(deadPort), timings: FAST, log: () => {} });
  t.after(() => bad.stop());
  bad.start({ host: "127.0.0.1", port: daemon.port });
  await until(() => bad.status().state === "error");
  assert.equal(bad.status().error, "unreachable");
});

test("同一私钥的第二个 connector 顶替第一个：被顶替方 state=error/replaced", async () => {
  const key = generateDeviceKey();
  const settings = settingsFor(relay.port, { deviceKey: key, deviceId: deriveDeviceId(key) });
  const timings = { backoffMinMs: 2_000, backoffMaxMs: 2_000, authBackoffMaxMs: 2_000 };
  const first = new RelayConnector({ settings, timings, log: () => {} });
  const second = new RelayConnector({ settings, timings, log: () => {} });
  try {
    first.start({ host: "127.0.0.1", port: daemon.port });
    await until(() => first.status().state === "connected");
    second.start({ host: "127.0.0.1", port: daemon.port });
    await until(() => first.status().state === "error");
    assert.equal(first.status().error, "replaced");
    assert.equal(second.status().state, "connected");
  } finally {
    await first.stop();
    await second.stop();
  }
});

test("心跳：relay 不回 pong 时断开并重连", async (t) => {
  const fake = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  await new Promise<void>((resolve) => fake.once("listening", () => resolve()));
  let connections = 0;
  fake.on("connection", () => {
    connections += 1;
  });
  t.after(() => new Promise<void>((resolve) => {
    for (const client of fake.clients) client.terminate();
    fake.close(() => resolve());
  }));
  const port = (fake.address() as AddressInfo).port;
  const hb = new RelayConnector({
    settings: settingsFor(port),
    timings: { ...FAST, heartbeatMs: 100 },
    log: () => {},
  });
  t.after(() => hb.stop());
  hb.start({ host: "127.0.0.1", port: daemon.port });
  await until(() => connections === 1);
  await until(() => connections >= 2, 2000);
});

test("stop()：进行中的 WS 被关闭、relay 侧设备离线、之后不再重连", async () => {
  const key = generateDeviceKey();
  const id = deriveDeviceId(key);
  const counter = countingWebSocket();
  const own = new RelayConnector({
    settings: settingsFor(relay.port, { deviceKey: key, deviceId: id }),
    timings: { backoffMinMs: 20, backoffMaxMs: 20, authBackoffMaxMs: 20 },
    WebSocket: counter.Impl,
    log: () => {},
  });
  own.start({ host: "127.0.0.1", port: daemon.port });
  await until(() => own.status().state === "connected");
  const phone = await wsConnect(`ws://127.0.0.1:${relay.port}/d/${id}/ws?token=${encodeURIComponent(TOKEN)}`);
  const phoneClosed = new Promise<void>((resolve) => phone.once("close", () => resolve()));

  await own.stop();
  await phoneClosed;
  assert.equal(own.status().state, "disabled");
  const offline = await request(`http://127.0.0.1:${relay.port}/d/${id}/api/health`, { headers: bearer });
  assert.equal(offline.status, 503);
  assert.deepEqual(json(offline), { error: "device_offline" });
  const attempts = counter.count();
  await delay(200);
  assert.equal(counter.count(), attempts);
});
