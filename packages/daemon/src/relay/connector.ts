// relay connector：daemon 主动连出到 relay（design §3.1），把 relay 转来的手机 HTTP / WS
// 在本机回环重放给 daemon 自己的端口。daemon 的路由、鉴权、上传、WS upgrade 原样复用。
//
// 安全：配对端点（/api/pair-info、/api/pair-qr.svg）在这里直接 403，不进 daemon；
// 其余回放请求一律带 X-Forwarded-*，即使路径判断被绕过，looksProxied() 也会让配对端点 403。
// 日志只记连接事件，不记 query、头、body、密钥。

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";

import { WebSocket, type RawData } from "ws";

import {
  CreditReceiver,
  CreditSender,
  DataType,
  checkControl,
  closeReason,
  encodeControl,
  encodeData,
  filterHeaders,
  parseControl,
  parseData,
  sendableCloseCode,
  type ControlFrame,
  type DataFrame,
  type FrameHeaders,
  type HttpOpenFrame,
  type OpenFrame,
  type WsOpenFrame,
} from "@claude-remote/relay/protocol";

import { relayBase, type RelaySettings } from "../config.js";
import type { RelayStatus } from "../server.js";

export interface ConnectorTimings {
  backoffMinMs: number;
  backoffMaxMs: number;
  /** 密钥错误、私钥不匹配、被替换时的退避上限，避免狂打 relay。 */
  authBackoffMaxMs: number;
  /** 每周期向 relay 发一次 ping；两个周期没有来自 relay 的任何活动即断开重连。 */
  heartbeatMs: number;
  handshakeTimeoutMs: number;
}

export const DEFAULT_CONNECTOR_TIMINGS: ConnectorTimings = {
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  authBackoffMaxMs: 300_000,
  heartbeatMs: 20_000,
  handshakeTimeoutMs: 15_000,
};

export interface ConnectorOptions {
  settings: RelaySettings;
  timings?: Partial<ConnectorTimings>;
  /** 测试可注入（计数连接次数等）。 */
  WebSocket?: typeof WebSocket;
  random?: () => number;
  log?: (line: string) => void;
}

export interface LoopbackTarget {
  host: string;
  port: number;
}

/** relay 被替换旧连接时的关闭码（packages/relay/src/server.ts CLOSE_REPLACED）。 */
const CLOSE_REPLACED = 4001;
const PAIR_PATHS = new Set(["/api/pair-info", "/api/pair-qr.svg"]);
const MAX_REJECT_BODY = 4096;

/** 回放目标：daemon 监听在通配地址时走 127.0.0.1。 */
export function loopbackTarget(address: { host: string; port: number }): LoopbackTarget {
  const host = address.host === "0.0.0.0" || address.host === "::" || address.host === "" ? "127.0.0.1" : address.host;
  return { host, port: address.port };
}

function hostPart(target: LoopbackTarget): string {
  return target.host.includes(":") ? `[${target.host}]` : target.host;
}

/**
 * 回放到 daemon 的请求头：去 hop-by-hop 与握手头，Host 改本机，追加 X-Forwarded-*。
 * 转发头让 daemon 的 looksProxied() 判定为代理请求（配对端点的第二层防护）。
 */
export function forwardHeaders(
  headers: FrameHeaders,
  remote: string,
  target: LoopbackTarget,
  relay: { host: string; proto: string },
): FrameHeaders {
  const out = filterHeaders(headers);
  for (const name of Object.keys(out)) {
    if (name === "host" || name.startsWith("sec-websocket-") || name.startsWith("x-forwarded-")) delete out[name];
  }
  out["host"] = `${hostPart(target)}:${target.port}`;
  out["x-forwarded-for"] = remote === "" ? "unknown" : remote;
  out["x-forwarded-proto"] = relay.proto;
  out["x-forwarded-host"] = relay.host;
  return out;
}

/** 与 daemon 相同的路径解析（WHATWG URL 会折叠 ./、%2e 等），保证拦截判断和 daemon 路由一致。 */
function pathnameOf(path: string): string {
  try {
    return new URL(path, "http://local").pathname;
  } catch {
    return path;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

// -- 一条 agent 连接 ----------------------------------------------------------

interface Stream {
  onControl(frame: ControlFrame): void;
  onData(frame: DataFrame): void;
  /** 本端主动中止：给 relay 发 reset 并释放本地资源。 */
  reset(reason: string): void;
  /** agent 连接已断：只释放本地资源，不再发帧。 */
  abandon(): void;
}

class Link {
  readonly streams = new Map<number, Stream>();

  constructor(
    readonly ws: WebSocket,
    readonly log: (line: string) => void,
  ) {}

  /** 发控制帧前自检；非法帧会让 relay 以 1008 断开整条连接，降级为只 reset 这个流并返回 false。 */
  control(frame: ControlFrame): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const text = encodeControl(frame);
    const check = checkControl(JSON.parse(text));
    if (check.ok) {
      this.ws.send(text);
      return true;
    }
    this.log(`dropping invalid ${frame.t} frame on stream ${frame.sid}: ${check.error}`);
    if (frame.t !== "reset") this.ws.send(encodeControl({ t: "reset", sid: frame.sid, reason: "agent_invalid_frame" }));
    return false;
  }

  /** 归还 credit；0 字节不需要（也不合法）。 */
  credit(sid: number, bytes: number): void {
    if (bytes > 0) this.control({ t: "credit", sid, bytes });
  }

  data(type: DataType, sid: number, payload: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeData(type, sid, payload));
  }

  drop(sid: number, stream: Stream): void {
    if (this.streams.get(sid) === stream) this.streams.delete(sid);
  }
}

interface StreamContext {
  link: Link;
  target: LoopbackTarget;
  relay: { host: string; proto: string };
  WebSocket: typeof WebSocket;
}

// -- HTTP 流 ------------------------------------------------------------------

class HttpStream implements Stream {
  readonly #ctx: StreamContext;
  readonly #sid: number;
  readonly #receiver = new CreditReceiver();
  readonly #sender: CreditSender;
  readonly #req: ClientRequest;
  #res: IncomingMessage | undefined;
  #done = false;

  constructor(ctx: StreamContext, open: HttpOpenFrame) {
    this.#ctx = ctx;
    this.#sid = open.sid;
    this.#sender = new CreditSender({
      send: (type, payload) => ctx.link.data(type, this.#sid, payload),
      resume: () => this.#res?.resume(),
    });
    this.#req = httpRequest({
      host: ctx.target.host,
      port: ctx.target.port,
      method: open.method,
      path: open.path,
      headers: forwardHeaders(open.headers, open.remote, ctx.target, ctx.relay),
      agent: false,
    });
    this.#req.on("response", (res) => this.#onResponse(res));
    this.#req.on("error", () => this.reset("upstream_error"));
  }

  onControl(frame: ControlFrame): void {
    if (this.#done) return;
    switch (frame.t) {
      case "end":
        this.#req.end();
        return;
      case "credit":
        this.#sender.credit(frame.bytes);
        return;
      case "reset":
        this.abandon();
        return;
      default:
        this.reset("protocol_error");
    }
  }

  onData(frame: DataFrame): void {
    if (this.#done) return;
    const size = frame.payload.length;
    if (frame.type !== DataType.HttpBody || !this.#receiver.admit(size)) return this.reset("protocol_error");
    this.#req.write(frame.payload, (error) => {
      if (error || this.#done) return;
      this.#receiver.release(size);
      this.#ctx.link.credit(this.#sid, size);
    });
  }

  reset(reason: string): void {
    if (this.#done) return;
    this.#ctx.link.control({ t: "reset", sid: this.#sid, reason });
    this.abandon();
  }

  abandon(): void {
    if (this.#done) return;
    this.#done = true;
    this.#ctx.link.drop(this.#sid, this);
    // daemon 可能没读完请求体就回了响应（如 401 / 413）：relay 不会再送 end，必须主动断开回环连接
    this.#req.destroy();
    this.#res?.destroy();
  }

  #onResponse(res: IncomingMessage): void {
    if (this.#done) {
      res.resume();
      return;
    }
    this.#res = res;
    const head = { t: "head", sid: this.#sid, status: res.statusCode ?? 502, headers: filterHeaders(res.headers) } as const;
    if (!this.#ctx.link.control(head)) return this.abandon();
    res.on("data", (chunk: Buffer) => {
      if (this.#done) return;
      if (!this.#sender.push(DataType.HttpBody, chunk)) res.pause();
    });
    res.on("end", () => {
      this.#sender.afterFlush(() => {
        if (this.#done) return;
        this.#ctx.link.control({ t: "end", sid: this.#sid });
        this.abandon();
      });
    });
    res.on("close", () => {
      if (!res.complete) this.reset("upstream_error");
    });
  }
}

// -- WS 流 --------------------------------------------------------------------

class WsStream implements Stream {
  readonly #ctx: StreamContext;
  readonly #sid: number;
  readonly #receiver = new CreditReceiver();
  readonly #sender: CreditSender;
  readonly #local: WebSocket;
  #accepted = false;
  #done = false;

  constructor(ctx: StreamContext, open: WsOpenFrame) {
    this.#ctx = ctx;
    this.#sid = open.sid;
    const local = new ctx.WebSocket(`ws://${hostPart(ctx.target)}:${ctx.target.port}${open.path}`, {
      headers: forwardHeaders(open.headers, open.remote, ctx.target, ctx.relay),
      perMessageDeflate: false,
    });
    this.#local = local;
    this.#sender = new CreditSender({
      send: (type, payload) => ctx.link.data(type, this.#sid, payload),
      resume: () => local.resume(),
    });
    local.on("open", () => {
      if (this.#done) return local.terminate();
      this.#accepted = true;
      if (!ctx.link.control({ t: "accept", sid: this.#sid })) this.abandon();
    });
    // daemon 拒绝 upgrade（如 token 错 401）：把状态码交给 relay，head 即流结束
    local.on("unexpected-response", (_req, res) => {
      res.resume();
      if (!this.#done) {
        ctx.link.control({ t: "head", sid: this.#sid, status: res.statusCode ?? 502, headers: filterHeaders(res.headers) });
        this.#release();
      }
      local.terminate();
    });
    local.on("message", (data, isBinary) => {
      if (this.#done) return;
      if (!this.#sender.push(isBinary ? DataType.WsBinary : DataType.WsText, toBuffer(data))) local.pause();
    });
    local.on("close", (code, reason) => {
      if (this.#done) return;
      if (!this.#accepted) return this.reset("upstream_error");
      // 关闭帧排在尚未发完的消息之后
      this.#sender.afterFlush(() => {
        if (this.#done) return;
        ctx.link.control({ t: "wsclose", sid: this.#sid, code: sendableCloseCode(code), reason: closeReason(reason.toString()) });
        this.#release();
      });
    });
    local.on("error", () => {
      // close 随后到达，统一在 close 里处理
    });
  }

  onControl(frame: ControlFrame): void {
    if (this.#done) return;
    switch (frame.t) {
      case "wsclose":
        if (!this.#accepted) return this.reset("protocol_error");
        this.#release();
        this.#local.close(sendableCloseCode(frame.code), closeReason(frame.reason));
        return;
      case "credit":
        this.#sender.credit(frame.bytes);
        return;
      case "reset":
        this.abandon();
        return;
      default:
        this.reset("protocol_error");
    }
  }

  onData(frame: DataFrame): void {
    if (this.#done) return;
    const size = frame.payload.length;
    if (!this.#accepted || frame.type === DataType.HttpBody || !this.#receiver.admit(size)) return this.reset("protocol_error");
    this.#local.send(frame.payload, { binary: frame.type === DataType.WsBinary }, (error) => {
      if (error || this.#done) return;
      this.#receiver.release(size);
      this.#ctx.link.credit(this.#sid, size);
    });
  }

  reset(reason: string): void {
    if (this.#done) return;
    this.#ctx.link.control({ t: "reset", sid: this.#sid, reason });
    this.abandon();
  }

  abandon(): void {
    if (this.#done) return;
    this.#release();
    this.#local.terminate();
  }

  #release(): void {
    this.#done = true;
    this.#ctx.link.drop(this.#sid, this);
  }
}

// -- connector ----------------------------------------------------------------

type ErrorCode =
  | "auth"
  | "device_key_mismatch"
  | "invalid_device"
  | "forbidden"
  | "replaced"
  | "protocol_error"
  | "unreachable"
  | `http_${number}`;

const AUTH_CLASS = new Set<string>(["auth", "device_key_mismatch", "invalid_device", "forbidden", "replaced"]);

function classifyRejection(status: number, body: string): ErrorCode {
  if (status === 401) return "auth";
  let code: unknown;
  try {
    code = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  if (status === 403) return code === "device_key_mismatch" ? "device_key_mismatch" : "forbidden";
  if (status === 400 && code === "invalid_device") return "invalid_device";
  return `http_${status}`;
}

export class RelayConnector {
  readonly #settings: RelaySettings;
  readonly #timings: ConnectorTimings;
  readonly #WebSocket: typeof WebSocket;
  readonly #random: () => number;
  readonly #log: (line: string) => void;
  readonly #base: string;
  readonly #relay: { host: string; proto: string };
  #target: LoopbackTarget | undefined;
  #state: RelayStatus["state"] = "connecting";
  #error: string | undefined;
  #since = Date.now();
  #link: Link | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #stopped = false;

  constructor(options: ConnectorOptions) {
    this.#settings = options.settings;
    this.#timings = { ...DEFAULT_CONNECTOR_TIMINGS, ...options.timings };
    this.#WebSocket = options.WebSocket ?? WebSocket;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? ((line) => console.log(`[relay] ${line}`));
    this.#base = relayBase(options.settings);
    const url = new URL(options.settings.url);
    this.#relay = { host: url.host, proto: url.protocol.replace(/:$/, "") };
  }

  status(): RelayStatus {
    return { state: this.#state, ...(this.#error === undefined ? {} : { error: this.#error }), base: this.#base, since: this.#since };
  }

  /** daemon listen() 之后调用；target 为 daemon 实际监听地址。 */
  start(address: { host: string; port: number }): void {
    if (this.#target !== undefined || this.#stopped) return;
    this.#target = loopbackTarget(address);
    this.#connect();
  }

  /** 关闭连接、reset 进行中的流、停止重连。 */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    const link = this.#link;
    this.#link = undefined;
    this.#setState("disabled", undefined);
    if (link === undefined) return;
    for (const stream of [...link.streams.values()]) stream.reset("agent_stopping");
    const ws = link.ws;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1_000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) ws.close(1001, "daemon_stopping");
      else ws.terminate();
    });
  }

  #setState(state: RelayStatus["state"], error: string | undefined): void {
    if (state === this.#state && error === this.#error) return;
    this.#state = state;
    this.#error = error;
    this.#since = Date.now();
  }

  #connect(): void {
    if (this.#stopped || this.#target === undefined) return;
    const url = `${this.#settings.url.replace(/^http/, "ws")}/agent`;
    const ws = new this.#WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.#settings.secret}`,
        "X-Device-Id": this.#settings.deviceId,
        "X-Device-Key": this.#settings.deviceKey,
      },
      handshakeTimeout: this.#timings.handshakeTimeoutMs,
      perMessageDeflate: false,
    });
    const link = new Link(ws, this.#log);
    this.#link = link;
    let failure: ErrorCode | undefined;
    let openedAt: number | undefined;
    let lastSeen = Date.now();
    const seen = (): void => {
      lastSeen = Date.now();
    };

    ws.on("open", () => {
      if (this.#stopped) return ws.terminate();
      openedAt = Date.now();
      seen();
      this.#setState("connected", undefined);
      this.#log(`connected to ${this.#relay.host} as ${this.#settings.deviceId}`);
      this.#heartbeatTimer = setInterval(() => {
        if (Date.now() - lastSeen > 2 * this.#timings.heartbeatMs) {
          this.#log("relay heartbeat lost, reconnecting");
          ws.terminate();
          return;
        }
        ws.ping();
      }, this.#timings.heartbeatMs);
      this.#heartbeatTimer.unref();
    });
    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < MAX_REJECT_BODY) body += chunk;
      });
      const done = (): void => {
        if (failure !== undefined) return;
        failure = classifyRejection(status, body);
        ws.terminate();
      };
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    ws.on("message", (data, isBinary) => {
      seen();
      this.#onMessage(link, data, isBinary);
    });
    ws.on("ping", seen);
    ws.on("pong", seen);
    ws.on("error", () => {
      // close 随后到达
    });
    ws.on("close", (code) => {
      this.#stopHeartbeat();
      for (const stream of [...link.streams.values()]) stream.abandon();
      link.streams.clear();
      if (this.#link !== link || this.#stopped) return;
      this.#link = undefined;
      // 连上过且稳定了一段时间才把退避清零；秒连秒断（如两台 Mac 用同一私钥互相顶替）继续退避
      if (openedAt !== undefined && Date.now() - openedAt >= this.#timings.heartbeatMs) this.#attempt = 0;
      let error: string | undefined = failure;
      if (openedAt !== undefined) {
        if (code === CLOSE_REPLACED) error = "replaced";
        else if (code === 1008) error = "protocol_error";
        if (error === undefined) {
          this.#log(`disconnected (${code}), reconnecting`);
          this.#setState("connecting", undefined);
        }
      } else {
        error ??= "unreachable";
      }
      if (error !== undefined) {
        if (error !== this.#error) this.#log(`relay connection failed: ${error}`);
        this.#setState("error", error);
      }
      this.#scheduleReconnect(error !== undefined && AUTH_CLASS.has(error));
    });
  }

  #scheduleReconnect(authClass: boolean): void {
    if (this.#stopped) return;
    const cap = authClass ? this.#timings.authBackoffMaxMs : this.#timings.backoffMaxMs;
    const exp = Math.min(cap, this.#timings.backoffMinMs * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 30);
    const delay = Math.round(exp * (0.75 + this.#random() * 0.25));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #onMessage(link: Link, data: RawData, isBinary: boolean): void {
    if (this.#link !== link) return;
    const buf = toBuffer(data);
    if (isBinary) {
      const parsed = parseData(buf);
      if (!parsed.ok) return this.#log(`ignoring bad data frame: ${parsed.error}`);
      link.streams.get(parsed.frame.sid)?.onData(parsed.frame);
      return;
    }
    const parsed = parseControl(buf.toString("utf8"));
    if (!parsed.ok) return this.#log(`ignoring bad control frame: ${parsed.error}`);
    const frame = parsed.frame;
    if (frame.t === "open") return this.#onOpen(link, frame);
    // 未知 sid 多半是与 reset 交错的迟到帧
    link.streams.get(frame.sid)?.onControl(frame);
  }

  #onOpen(link: Link, open: OpenFrame): void {
    if (link.streams.has(open.sid)) {
      link.control({ t: "reset", sid: open.sid, reason: "duplicate_sid" });
      return;
    }
    if (open.kind === "http" && PAIR_PATHS.has(pathnameOf(open.path))) return this.#rejectPair(link, open.sid);
    const ctx: StreamContext = { link, target: this.#target as LoopbackTarget, relay: this.#relay, WebSocket: this.#WebSocket };
    try {
      const stream = open.kind === "http" ? new HttpStream(ctx, open) : new WsStream(ctx, open);
      link.streams.set(open.sid, stream);
    } catch {
      // http.request / new WebSocket 对个别参数组合会同步抛错：只拒这个流
      link.control({ t: "reset", sid: open.sid, reason: "bad_request" });
    }
  }

  /** 配对端点经 relay 一律 403，不进 daemon（token 不能经 relay 下发）。 */
  #rejectPair(link: Link, sid: number): void {
    const body = Buffer.from(JSON.stringify({ error: "loopback_only" }));
    link.control({
      t: "head",
      sid,
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" },
    });
    link.data(DataType.HttpBody, sid, body);
    link.control({ t: "end", sid });
  }
}
