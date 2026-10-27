// relay 服务：把手机发到 /d/<deviceId>/* 的 HTTP 与 WS 透明转发给对应 Mac 的 agent 长连接。
//
// relay 无状态：设备 ID 由设备私钥派生，接入时现场校验，不落盘。不解析业务内容，
// 也不接触 BRIDGE_TOKEN；手机的 Bearer / ?token= 原样交给 daemon 校验。
// 日志只记设备 ID、方法、去 query 的路径、状态码与耗时（WS 的 token 在 query 里）。

import { createHash, timingSafeEqual } from "node:crypto";
import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { RelayConfig } from "./config.js";
import {
  CreditReceiver,
  CreditSender,
  DataType,
  checkControl,
  closeReason,
  deriveDeviceId,
  encodeControl,
  encodeData,
  filterHeaders,
  isDeviceId,
  isDeviceKey,
  parseControl,
  parseData,
  sendableCloseCode,
  type ControlFrame,
  type DataFrame,
  type FrameHeaders,
  type OpenFrame,
} from "./protocol.js";

export interface RelayTimings {
  /** 请求体转发完（WS 为发出 open）后等待 head/accept 的上限。 */
  headTimeoutMs: number;
  /** HTTP 流无任何数据的上限；WS 流不受此限。 */
  idleTimeoutMs: number;
  /** agent 与手机 WS 的 ping 周期；连续两个周期无 pong 即断开。 */
  heartbeatMs: number;
}

export const DEFAULT_TIMINGS: RelayTimings = { headTimeoutMs: 30_000, idleTimeoutMs: 120_000, heartbeatMs: 20_000 };

export interface RelayOptions extends RelayConfig {
  version?: string;
  timings?: Partial<RelayTimings>;
  log?: (line: string) => void;
}

export interface RelayHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** agent 被替换时旧连接的关闭码。 */
export const CLOSE_REPLACED = 4001;

const DEVICE_PATH_RE = /^\/d\/([^/?]+)(.*)$/s;
const MAX_REMOTE_LENGTH = 256;

interface Context {
  readonly config: RelayOptions;
  readonly timings: RelayTimings;
  readonly phoneWss: WebSocketServer;
  readonly heartbeat: Heartbeat;
  log(line: string): void;
}

interface Stream {
  onControl(frame: ControlFrame): void;
  onData(frame: DataFrame): void;
  /** agent 连接已断：只处理手机侧，不再给 agent 发帧。 */
  abandon(code: string): void;
}

// -- 心跳 -------------------------------------------------------------------

class Heartbeat {
  readonly #missed = new Map<WebSocket, number>();
  readonly #timer: NodeJS.Timeout;

  constructor(intervalMs: number) {
    this.#timer = setInterval(() => this.#tick(), intervalMs);
  }

  add(ws: WebSocket): void {
    this.#missed.set(ws, 0);
    ws.on("pong", () => {
      if (this.#missed.has(ws)) this.#missed.set(ws, 0);
    });
    ws.once("close", () => this.#missed.delete(ws));
  }

  sockets(): WebSocket[] {
    return [...this.#missed.keys()];
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  #tick(): void {
    for (const [ws, missed] of this.#missed) {
      if (missed >= 2) {
        this.#missed.delete(ws);
        ws.terminate();
        continue;
      }
      this.#missed.set(ws, missed + 1);
      ws.ping();
    }
  }
}

// -- agent 连接 -------------------------------------------------------------

class Agent {
  readonly streams = new Map<number, Stream>();
  #nextSid = 1;

  constructor(
    readonly id: string,
    readonly ws: WebSocket,
  ) {}

  allocSid(): number {
    while (this.streams.has(this.#nextSid)) this.#advance();
    const sid = this.#nextSid;
    this.#advance();
    return sid;
  }

  sendControl(frame: ControlFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeControl(frame));
  }

  sendData(type: DataType, sid: number, payload: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeData(type, sid, payload));
  }

  shutdown(code: string): void {
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.abandon(code);
  }

  #advance(): void {
    this.#nextSid = this.#nextSid >= 0xffffffff ? 1 : this.#nextSid + 1;
  }
}

// -- 工具 -------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
    ...extra,
  });
  res.end(text);
}

function rawResponse(status: number, headers: Record<string, string | string[]>, body = ""): string {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body);
  return lines.join("\r\n");
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed) return;
  socket.end(rawResponse(status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ error: code })), () =>
    socket.destroy(),
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function remoteOf(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return (first || req.socket.remoteAddress || "").slice(0, MAX_REMOTE_LENGTH);
}

function stripQuery(path: string): string {
  const i = path.indexOf("?");
  return i === -1 ? path : path.slice(0, i);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 解析 /d/<id><rest>；rest 为空或以 ? 开头时补成根路径。 */
function matchDevice(url: string): { id: string; path: string } | undefined {
  const m = DEVICE_PATH_RE.exec(url);
  if (m === null) return undefined;
  const id = m[1] ?? "";
  const rest = m[2] ?? "";
  if (!isDeviceId(id)) return undefined;
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) return undefined;
  return { id, path: rest.startsWith("/") ? rest : `/${rest}` };
}

/** 发帧前自检：手机请求里的奇异路径/头不能变成会让 agent 判协议错误的帧。 */
function validOpen(frame: OpenFrame): boolean {
  return checkControl(JSON.parse(encodeControl(frame))).ok;
}

// -- HTTP 流 ----------------------------------------------------------------

class HttpStream implements Stream {
  readonly sid: number;
  readonly #receiver = new CreditReceiver();
  readonly #sender: CreditSender;
  readonly #started = Date.now();
  #done = false;
  #bodyBytes = 0;
  #headTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #status = 0;

  constructor(
    readonly agent: Agent,
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
    readonly path: string,
    readonly ctx: Context,
  ) {
    this.sid = agent.allocSid();
    this.#sender = new CreditSender({
      send: (type, payload) => agent.sendData(type, this.sid, payload),
      resume: () => req.resume(),
    });
  }

  start(): boolean {
    const open: OpenFrame = {
      t: "open",
      sid: this.sid,
      kind: "http",
      method: this.req.method ?? "GET",
      path: this.path,
      headers: filterHeaders(this.req.headers),
      remote: remoteOf(this.req),
    };
    if (!validOpen(open)) return false;
    this.agent.streams.set(this.sid, this);
    this.agent.sendControl(open);
    this.#idleTimer = setTimeout(() => this.#onIdle(), this.ctx.timings.idleTimeoutMs);

    this.req.on("data", (chunk: Buffer) => {
      if (this.#done) return;
      this.#bodyBytes += chunk.length;
      if (this.#bodyBytes > this.ctx.config.maxBodyBytes) {
        this.#reset("body_too_large");
        this.#respondError(413, "body_too_large", { Connection: "close" });
        return;
      }
      this.#touch();
      if (!this.#sender.push(DataType.HttpBody, chunk)) this.req.pause();
    });
    this.req.on("end", () => {
      this.#sender.afterFlush(() => {
        if (this.#done) return;
        this.agent.sendControl({ t: "end", sid: this.sid });
        // 等 head 从请求体转发完才计时：慢速上传期间 daemon 本来就回不了 head
        if (this.#status === 0) this.#headTimer = setTimeout(() => this.#onHeadTimeout(), this.ctx.timings.headTimeoutMs);
      });
    });
    this.res.on("close", () => {
      if (this.#done) return;
      this.#reset("client_closed");
      this.#finish(499);
    });
    return true;
  }

  onControl(frame: ControlFrame): void {
    switch (frame.t) {
      case "head":
        if (this.#status !== 0) return this.#violation();
        this.#clearHeadTimer();
        try {
          this.res.writeHead(frame.status, filterHeaders(frame.headers));
        } catch {
          return this.#violation();
        }
        this.#status = frame.status;
        this.#touch();
        return;
      case "end":
        if (this.#status === 0) return this.#violation();
        this.#finish(this.#status);
        this.res.end();
        return;
      case "reset":
        this.#respondError(502, "upstream_reset");
        return;
      case "credit":
        this.#touch();
        this.#sender.credit(frame.bytes);
        return;
      default:
        this.#violation();
    }
  }

  onData(frame: DataFrame): void {
    const size = frame.payload.length;
    if (frame.type !== DataType.HttpBody || this.#status === 0 || !this.#receiver.admit(size)) return this.#violation();
    this.#touch();
    this.res.write(frame.payload, (error) => {
      if (error || this.#done) return;
      this.#touch();
      this.#receiver.release(size);
      if (size > 0) this.agent.sendControl({ t: "credit", sid: this.sid, bytes: size });
    });
  }

  abandon(code: string): void {
    this.#respondError(502, code);
  }

  #violation(): void {
    this.#reset("protocol_error");
    this.#respondError(502, "upstream_protocol_error");
  }

  #onHeadTimeout(): void {
    if (this.#done || this.#status !== 0) return;
    this.#reset("head_timeout");
    this.#respondError(504, "upstream_timeout");
  }

  #onIdle(): void {
    if (this.#done) return;
    this.#reset("idle_timeout");
    this.#respondError(504, "idle_timeout");
  }

  #touch(): void {
    this.#idleTimer?.refresh();
  }

  #clearHeadTimer(): void {
    if (this.#headTimer !== undefined) clearTimeout(this.#headTimer);
  }

  #reset(reason: string): void {
    if (!this.#done) this.agent.sendControl({ t: "reset", sid: this.sid, reason });
  }

  /** 结束流：响应头未发则回 JSON 错误，已发则只能断开。 */
  #respondError(status: number, code: string, extra: Record<string, string> = {}): void {
    if (this.#done) return;
    this.#finish(this.res.headersSent ? this.#status : status);
    if (this.res.headersSent) {
      this.res.destroy();
    } else {
      sendJson(this.res, status, { error: code }, extra);
    }
  }

  #finish(status: number): void {
    if (this.#done) return;
    this.#done = true;
    this.#clearHeadTimer();
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    if (this.agent.streams.get(this.sid) === this) this.agent.streams.delete(this.sid);
    // 剩余请求体丢弃即可；不 resume 的话保活连接会卡在暂停状态
    this.req.removeAllListeners("data");
    this.req.resume();
    this.ctx.log(`${this.agent.id} ${this.req.method ?? "GET"} ${stripQuery(this.path)} ${status} ${Date.now() - this.#started}ms`);
  }
}

// -- WS 流 ------------------------------------------------------------------

class WsStream implements Stream {
  readonly sid: number;
  readonly #receiver = new CreditReceiver();
  readonly #started = Date.now();
  #sender: CreditSender | undefined;
  #phone: WebSocket | undefined;
  #done = false;
  #accepting = false;
  #headTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly agent: Agent,
    readonly req: IncomingMessage,
    readonly socket: Duplex,
    readonly head: Buffer,
    readonly path: string,
    readonly ctx: Context,
  ) {
    this.sid = agent.allocSid();
  }

  start(): boolean {
    const headers = filterHeaders(this.req.headers);
    // 握手专用头由 agent 与 daemon 之间重新协商
    for (const name of Object.keys(headers)) if (name.startsWith("sec-websocket-")) delete headers[name];
    const open: OpenFrame = { t: "open", sid: this.sid, kind: "ws", path: this.path, headers, remote: remoteOf(this.req) };
    if (!validOpen(open)) return false;
    this.agent.streams.set(this.sid, this);
    this.agent.sendControl(open);
    this.#headTimer = setTimeout(() => this.#onHeadTimeout(), this.ctx.timings.headTimeoutMs);
    this.socket.on("close", () => {
      if (this.#done || this.#phone !== undefined) return;
      this.#reset("client_closed");
      this.#finish(499);
    });
    return true;
  }

  onControl(frame: ControlFrame): void {
    switch (frame.t) {
      case "accept":
        if (this.#accepting) return this.#violation();
        this.#accepting = true;
        this.#clearHeadTimer();
        if (this.socket.destroyed) {
          this.#reset("client_closed");
          this.#finish(499);
          return;
        }
        this.ctx.phoneWss.handleUpgrade(this.req, this.socket, this.head, (ws) => this.#attach(ws));
        return;
      case "head": {
        if (this.#accepting) return this.#violation();
        this.#finish(frame.status);
        const headers: FrameHeaders = filterHeaders(frame.headers);
        delete headers["content-length"];
        if (!this.socket.destroyed) this.socket.end(rawResponse(frame.status, headers), () => this.socket.destroy());
        return;
      }
      case "wsclose":
        if (this.#phone === undefined) return this.#violation();
        this.#finish(101);
        this.#phone.close(sendableCloseCode(frame.code), frame.reason);
        return;
      case "reset":
        this.abandon("upstream_reset");
        return;
      case "credit":
        this.#sender?.credit(frame.bytes);
        return;
      default:
        this.#violation();
    }
  }

  onData(frame: DataFrame): void {
    const phone = this.#phone;
    const size = frame.payload.length;
    if (phone === undefined || frame.type === DataType.HttpBody || !this.#receiver.admit(size)) return this.#violation();
    phone.send(frame.payload, { binary: frame.type === DataType.WsBinary }, (error) => {
      if (error || this.#done) return;
      this.#receiver.release(size);
      if (size > 0) this.agent.sendControl({ t: "credit", sid: this.sid, bytes: size });
    });
  }

  abandon(code: string): void {
    if (this.#done) return;
    const phone = this.#phone;
    if (phone !== undefined) {
      this.#finish(101);
      phone.close(1011, closeReason(code));
    } else {
      this.#finish(502);
      rejectUpgrade(this.socket, 502, code);
    }
  }

  #attach(ws: WebSocket): void {
    if (this.#done) {
      ws.terminate();
      return;
    }
    this.#phone = ws;
    this.ctx.heartbeat.add(ws);
    const sender = new CreditSender({
      send: (type, payload) => this.agent.sendData(type, this.sid, payload),
      resume: () => ws.resume(),
    });
    this.#sender = sender;
    ws.on("message", (data, isBinary) => {
      if (this.#done) return;
      if (!sender.push(isBinary ? DataType.WsBinary : DataType.WsText, toBuffer(data))) ws.pause();
    });
    ws.on("close", (code, reason) => {
      if (this.#done) return;
      // 队列里还有未发完的消息时没有窗口可等（流即将释放），直接 reset
      if (sender.queuedBytes > 0) this.#reset("client_closed");
      else this.agent.sendControl({ t: "wsclose", sid: this.sid, code, reason: closeReason(reason.toString()) });
      this.#finish(101);
    });
    ws.on("error", () => ws.terminate());
  }

  #violation(): void {
    this.#reset("protocol_error");
    this.abandon("upstream_protocol_error");
  }

  #onHeadTimeout(): void {
    if (this.#done || this.#accepting) return;
    this.#reset("head_timeout");
    this.#finish(504);
    rejectUpgrade(this.socket, 504, "upstream_timeout");
  }

  #clearHeadTimer(): void {
    if (this.#headTimer !== undefined) clearTimeout(this.#headTimer);
  }

  #reset(reason: string): void {
    if (!this.#done) this.agent.sendControl({ t: "reset", sid: this.sid, reason });
  }

  #finish(status: number): void {
    if (this.#done) return;
    this.#done = true;
    this.#clearHeadTimer();
    if (this.agent.streams.get(this.sid) === this) this.agent.streams.delete(this.sid);
    this.ctx.log(`${this.agent.id} WS ${stripQuery(this.path)} ${status} ${Date.now() - this.#started}ms`);
  }
}

// -- relay ------------------------------------------------------------------

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const timings: RelayTimings = { ...DEFAULT_TIMINGS, ...options.timings };
  const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
  const version = options.version ?? "unknown";
  const expectedAuth = digest(`Bearer ${options.secret}`);
  const devices = new Map<string, Agent>();
  const agentWss = new WebSocketServer({ noServer: true });
  const phoneWss = new WebSocketServer({ noServer: true, maxPayload: options.maxBodyBytes });
  const heartbeat = new Heartbeat(timings.heartbeatMs);
  const ctx: Context = { config: options, timings, phoneWss, heartbeat, log };

  const authOk = (req: IncomingMessage): boolean => timingSafeEqual(digest(req.headers.authorization ?? ""), expectedAuth);

  function protocolError(agent: Agent, error: string): void {
    log(`agent ${agent.id} protocol error: ${error}`);
    if (devices.get(agent.id) === agent) devices.delete(agent.id);
    agent.ws.close(1008, "protocol_error");
    agent.shutdown("device_disconnected");
  }

  function onAgentMessage(agent: Agent, data: RawData, isBinary: boolean): void {
    if (devices.get(agent.id) !== agent) return;
    if (isBinary) {
      const parsed = parseData(toBuffer(data));
      if (!parsed.ok) return protocolError(agent, parsed.error);
      agent.streams.get(parsed.frame.sid)?.onData(parsed.frame);
      return;
    }
    const parsed = parseControl(toBuffer(data).toString("utf8"));
    if (!parsed.ok) return protocolError(agent, parsed.error);
    if (parsed.frame.t === "open") return protocolError(agent, "unexpected_open");
    // 未知 sid 多半是与 reset 交错的迟到帧，忽略
    agent.streams.get(parsed.frame.sid)?.onControl(parsed.frame);
  }

  function attachAgent(id: string, ws: WebSocket): void {
    const agent = new Agent(id, ws);
    const previous = devices.get(id);
    devices.set(id, agent);
    heartbeat.add(ws);
    if (previous !== undefined) {
      log(`agent ${id} replaced`);
      previous.shutdown("device_disconnected");
      previous.ws.close(CLOSE_REPLACED, "replaced");
    }
    log(`agent ${id} connected`);
    ws.on("message", (data, isBinary) => onAgentMessage(agent, data, isBinary));
    ws.on("close", () => {
      if (devices.get(id) === agent) {
        devices.delete(id);
        log(`agent ${id} disconnected`);
      }
      agent.shutdown("device_disconnected");
    });
    ws.on("error", () => ws.terminate());
  }

  function onAgentUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!authOk(req)) return rejectUpgrade(socket, 401, "unauthorized");
    const id = singleHeader(req, "x-device-id");
    const key = singleHeader(req, "x-device-key");
    if (!isDeviceId(id) || !isDeviceKey(key)) return rejectUpgrade(socket, 400, "invalid_device");
    if (deriveDeviceId(key) !== id) return rejectUpgrade(socket, 403, "device_key_mismatch");
    agentWss.handleUpgrade(req, socket, head, (ws) => attachAgent(id, ws));
  }

  function onPhoneUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, id: string, path: string): void {
    const agent = devices.get(id);
    const reject = (status: number, code: string): void => {
      log(`${id} WS ${stripQuery(path)} ${status} 0ms`);
      rejectUpgrade(socket, status, code);
    };
    if (agent === undefined) return reject(503, "device_offline");
    if (agent.streams.size >= options.maxStreams) return reject(503, "too_many_streams");
    if (!new WsStream(agent, req, socket, head, path, ctx).start()) reject(400, "bad_request");
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (stripQuery(url) === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      return sendJson(res, 200, { ok: true, version });
    }
    const target = matchDevice(url);
    if (target === undefined) return sendJson(res, 404, { error: "not_found" });
    const started = Date.now();
    const reject = (status: number, code: string, extra: Record<string, string> = {}): void => {
      log(`${target.id} ${req.method ?? "GET"} ${stripQuery(target.path)} ${status} ${Date.now() - started}ms`);
      sendJson(res, status, { error: code }, extra);
    };
    const agent = devices.get(target.id);
    if (agent === undefined) return reject(503, "device_offline");
    if (agent.streams.size >= options.maxStreams) return reject(503, "too_many_streams");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > options.maxBodyBytes) return reject(413, "body_too_large", { Connection: "close" });
    if (!new HttpStream(agent, req, res, target.path, ctx).start()) reject(400, "bad_request");
  }

  const server = createServer(onRequest);
  // 要长于前置反代（Caddy 默认 2 分钟）的上游空闲连接保持时间，否则反代复用刚被关闭的连接会偶发 502
  server.keepAliveTimeout = 130_000;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = req.url ?? "/";
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") return rejectUpgrade(socket, 400, "bad_upgrade");
    if (stripQuery(url) === "/agent") return onAgentUpgrade(req, socket, head);
    const target = matchDevice(url);
    if (target === undefined || stripQuery(target.path) !== "/ws") return rejectUpgrade(socket, 404, "not_found");
    onPhoneUpgrade(req, socket, head, target.id, target.path);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    host: address.address,
    port: address.port,
    async close() {
      heartbeat.stop();
      for (const agent of devices.values()) agent.shutdown("relay_closing");
      for (const ws of heartbeat.sockets()) ws.terminate();
      devices.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
