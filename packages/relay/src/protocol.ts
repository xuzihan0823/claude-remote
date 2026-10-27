// relay 隧道协议：relay 与 daemon connector 共用（@claude-remote/relay/protocol），两端只有这一份实现。
//
// 一条 agent WS 上多路复用多个流，sid 由 relay 分配。控制帧是 JSON 文本帧，
// 数据帧是二进制帧 [u8 type][u32 sid 大端][payload]。两端互不信任：解析函数对
// 非法输入返回 { ok: false }，从不抛出。
//
// 流的生命周期约定：
// - http：relay 发 open → 请求体 data(1)… → end；agent 回 head → 响应体 data(1)… → end。
//   任一方 reset 即中止，双方立即释放该 sid。
// - ws：relay 发 open；agent 回 accept 后双方互发 data(2/3)，任一方 wsclose 结束；
//   agent 回 head 表示拒绝 upgrade，head 发出即视为流结束（不再发 end）。

import { createHash, randomBytes } from "node:crypto";

/** 每个流每个方向的初始发送窗口。 */
export const INITIAL_WINDOW = 256 * 1024;

export const DataType = { HttpBody: 1, WsText: 2, WsBinary: 3 } as const;
export type DataType = (typeof DataType)[keyof typeof DataType];

export type FrameHeaders = Record<string, string | string[]>;

export interface HttpOpenFrame {
  t: "open";
  sid: number;
  kind: "http";
  method: string;
  /** 已去掉 /d/<id> 前缀，含原样 query。 */
  path: string;
  headers: FrameHeaders;
  /** 手机来源 IP。 */
  remote: string;
}

export interface WsOpenFrame {
  t: "open";
  sid: number;
  kind: "ws";
  path: string;
  headers: FrameHeaders;
  remote: string;
}

export type OpenFrame = HttpOpenFrame | WsOpenFrame;

export interface HeadFrame {
  t: "head";
  sid: number;
  status: number;
  headers: FrameHeaders;
}

export interface AcceptFrame {
  t: "accept";
  sid: number;
}

export interface EndFrame {
  t: "end";
  sid: number;
}

export interface WsCloseFrame {
  t: "wsclose";
  sid: number;
  code: number;
  reason: string;
}

export interface ResetFrame {
  t: "reset";
  sid: number;
  reason: string;
}

export interface CreditFrame {
  t: "credit";
  sid: number;
  bytes: number;
}

export type ControlFrame = OpenFrame | HeadFrame | AcceptFrame | EndFrame | WsCloseFrame | ResetFrame | CreditFrame;

export interface DataFrame {
  type: DataType;
  sid: number;
  payload: Buffer;
}

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; error: string };

const MAX_SID = 0xffffffff;
const MAX_PATH_LENGTH = 16 * 1024;
const MAX_TEXT_LENGTH = 256;
/** WS close reason 的协议上限（字节）。 */
const MAX_CLOSE_REASON_BYTES = 123;
const DATA_HEADER_BYTES = 5;

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// 与 Node http 的头部值校验一致，避免 writeHead 抛错
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;
const PATH_RE = /^\/[\x21-\x7e]*$/;

export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

export function encodeData(type: DataType, sid: number, payload: Uint8Array): Buffer {
  const buf = Buffer.allocUnsafe(DATA_HEADER_BYTES + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(sid, 1);
  buf.set(payload, DATA_HEADER_BYTES);
  return buf;
}

export function parseData(buf: Buffer): ParseResult<DataFrame> {
  if (buf.length < DATA_HEADER_BYTES) return { ok: false, error: "data_frame_too_short" };
  const type = buf.readUInt8(0);
  if (type !== DataType.HttpBody && type !== DataType.WsText && type !== DataType.WsBinary) {
    return { ok: false, error: "unknown_data_type" };
  }
  const sid = buf.readUInt32BE(1);
  if (sid === 0) return { ok: false, error: "invalid_sid" };
  return { ok: true, frame: { type, sid, payload: buf.subarray(DATA_HEADER_BYTES) } };
}

class FrameError extends Error {}

function fail(message: string): never {
  throw new FrameError(message);
}

function field(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function readSid(obj: Record<string, unknown>): number {
  const sid = field(obj, "sid");
  if (typeof sid !== "number" || !Number.isInteger(sid) || sid < 1 || sid > MAX_SID) fail("invalid_sid");
  return sid;
}

function readInt(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = field(obj, key);
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`invalid_${key}`);
  return value;
}

function readText(obj: Record<string, unknown>, key: string, maxLength = MAX_TEXT_LENGTH): string {
  const value = field(obj, key);
  if (typeof value !== "string" || value.length > maxLength) fail(`invalid_${key}`);
  return value;
}

function readPath(obj: Record<string, unknown>): string {
  const path = field(obj, "path");
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || !PATH_RE.test(path)) fail("invalid_path");
  return path;
}

function readHeaders(obj: Record<string, unknown>): FrameHeaders {
  const raw = field(obj, "headers");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("invalid_headers");
  const headers: FrameHeaders = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TOKEN_RE.test(name) || name === "__proto__") fail("invalid_header_name");
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== "string" || !HEADER_VALUE_RE.test(v)) fail("invalid_header_value");
    }
    headers[name] = Array.isArray(value) ? [...(value as string[])] : (value as string);
  }
  return headers;
}

function decodeControl(obj: Record<string, unknown>): ControlFrame {
  const t = field(obj, "t");
  switch (t) {
    case "open": {
      const sid = readSid(obj);
      const kind = field(obj, "kind");
      const path = readPath(obj);
      const headers = readHeaders(obj);
      const remote = readText(obj, "remote");
      if (kind === "http") {
        const method = field(obj, "method");
        if (typeof method !== "string" || method.length > 32 || !TOKEN_RE.test(method)) fail("invalid_method");
        return { t, sid, kind, method, path, headers, remote };
      }
      if (kind === "ws") return { t, sid, kind, path, headers, remote };
      return fail("invalid_kind");
    }
    case "head":
      return { t, sid: readSid(obj), status: readInt(obj, "status", 200, 599), headers: readHeaders(obj) };
    case "accept":
    case "end":
      return { t, sid: readSid(obj) };
    case "wsclose": {
      const sid = readSid(obj);
      const code = readInt(obj, "code", 1000, 4999);
      const reason = readText(obj, "reason");
      if (Buffer.byteLength(reason) > MAX_CLOSE_REASON_BYTES) fail("invalid_reason");
      return { t, sid, code, reason };
    }
    case "reset":
      return { t, sid: readSid(obj), reason: readText(obj, "reason") };
    case "credit":
      return { t, sid: readSid(obj), bytes: readInt(obj, "bytes", 1, MAX_SID) };
    default:
      return fail("unknown_frame_type");
  }
}

export function parseControl(text: string): ParseResult<ControlFrame> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  return checkControl(value);
}

/** 校验一个已解析的对象是否为合法控制帧；发送方也可以用它在发出前自检。 */
export function checkControl(value: unknown): ParseResult<ControlFrame> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "not_an_object" };
  try {
    return { ok: true, frame: decodeControl(value as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof FrameError) return { ok: false, error: error.message };
    throw error;
  }
}

// -- 头部 -------------------------------------------------------------------

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer"]);

/** 去掉 hop-by-hop 头（含 proxy-* 与 Connection 里点名的头），统一小写，丢弃非法值。 */
export function filterHeaders(input: Record<string, string | string[] | number | undefined>): FrameHeaders {
  const connection = input["connection"] ?? input["Connection"];
  const named = new Set(
    (Array.isArray(connection) ? connection.join(",") : String(connection ?? ""))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: FrameHeaders = {};
  for (const [rawName, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (!TOKEN_RE.test(name) || name === "__proto__" || HOP_BY_HOP.has(name) || name.startsWith("proxy-") || named.has(name)) continue;
    const values = (Array.isArray(value) ? value : [String(value)]).filter((v) => HEADER_VALUE_RE.test(v));
    if (values.length === 0) continue;
    out[name] = Array.isArray(value) ? values : (values[0] as string);
  }
  return out;
}

/** 把收到的关闭码映射为 ws.close() 可用的值；1005/1006/1015 等保留码只能观察不能发送。 */
export function sendableCloseCode(code: number): number {
  const ok = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
  return ok ? code : 1000;
}

/** 截断到 WS close reason 允许的 123 字节以内。 */
export function closeReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out) > MAX_CLOSE_REASON_BYTES) out = out.slice(0, -1);
  return out;
}

// -- 设备身份 ---------------------------------------------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DEVICE_ID_RE = /^[a-z2-7]{20}$/;
const DEVICE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** 设备 ID = base32 小写(sha256("claude-remote-relay/v1:" + key)) 前 20 位。 */
export function deriveDeviceId(key: string): string {
  return base32(createHash("sha256").update(`claude-remote-relay/v1:${key}`).digest()).slice(0, 20);
}

/** 32 字节随机设备私钥，base64url 无填充（43 字符）。 */
export function generateDeviceKey(): string {
  return randomBytes(32).toString("base64url");
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_RE.test(value);
}

export function isDeviceKey(value: unknown): value is string {
  return typeof value === "string" && DEVICE_KEY_RE.test(value);
}

// -- 流控 -------------------------------------------------------------------

export interface CreditSenderHooks {
  /** 实际发出一个数据帧的载荷（调用方负责 encodeData 与写 agent WS）。 */
  send(type: DataType, payload: Buffer): void;
  /** 之前 push 返回过 false，现在窗口重新打开且队列清空：恢复读取上游。 */
  resume(): void;
}

/**
 * 单个流单个方向的发送端记账。
 *
 * 用法：上游每来一块数据调用 push()，返回 false 时暂停读取上游；收到对端 credit 帧时调用
 * credit()，窗口重新打开后会回调 hooks.resume()。end / wsclose 等控制帧通过 afterFlush()
 * 发出，保证不会越过尚在队列里的数据。
 *
 * HTTP 体（type 1）可按窗口切分；WS 消息（type 2/3）保持整条：放得下才发，单条超过窗口时
 * 只在没有未确认数据时放行，因此接收方缓冲不超过 max(窗口, 单条消息)。
 */
export class CreditSender {
  readonly #hooks: CreditSenderHooks;
  readonly #initial: number;
  #window: number;
  #queue: { type: DataType; payload: Buffer }[] = [];
  #queuedBytes = 0;
  #blocked = false;
  #afterFlush: (() => void)[] = [];

  constructor(hooks: CreditSenderHooks, initialWindow = INITIAL_WINDOW) {
    this.#hooks = hooks;
    this.#initial = initialWindow;
    this.#window = initialWindow;
  }

  get window(): number {
    return this.#window;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  push(type: DataType, payload: Buffer): boolean {
    this.#queue.push({ type, payload });
    this.#queuedBytes += payload.length;
    this.#flush();
    const open = this.#queue.length === 0 && this.#window > 0;
    if (!open) this.#blocked = true;
    return open;
  }

  credit(bytes: number): void {
    this.#window += bytes;
    this.#flush();
    if (this.#blocked && this.#queue.length === 0 && this.#window > 0) {
      this.#blocked = false;
      this.#hooks.resume();
    }
  }

  afterFlush(fn: () => void): void {
    if (this.#queue.length === 0) fn();
    else this.#afterFlush.push(fn);
  }

  #flush(): void {
    while (this.#queue.length > 0) {
      const item = this.#queue[0] as { type: DataType; payload: Buffer };
      const size = item.payload.length;
      if (item.type === DataType.HttpBody) {
        if (size === 0) {
          this.#queue.shift();
          continue;
        }
        if (this.#window <= 0) break;
        const n = Math.min(this.#window, size);
        this.#hooks.send(item.type, n === size ? item.payload : item.payload.subarray(0, n));
        this.#window -= n;
        this.#queuedBytes -= n;
        if (n === size) this.#queue.shift();
        else item.payload = item.payload.subarray(n);
      } else {
        if (size > this.#window && this.#window < this.#initial) break;
        this.#hooks.send(item.type, item.payload);
        this.#window -= size;
        this.#queuedBytes -= size;
        this.#queue.shift();
      }
    }
    if (this.#queue.length === 0 && this.#afterFlush.length > 0) {
      const pending = this.#afterFlush;
      this.#afterFlush = [];
      for (const fn of pending) fn();
    }
  }
}

/**
 * 单个流单个方向的接收端记账：校验对端没有越过窗口，下游写完后归还 credit。
 *
 * 用法：收到数据帧先 admit(n)，返回 false 说明对端违反流控（应 reset 该流）；写入下游的
 * 回调里调用 release(n)，再把同样的字节数作为 credit 帧发回对端。
 */
export class CreditReceiver {
  readonly #initial: number;
  #outstanding = 0;

  constructor(initialWindow = INITIAL_WINDOW) {
    this.#initial = initialWindow;
  }

  get outstanding(): number {
    return this.#outstanding;
  }

  admit(bytes: number): boolean {
    // 未确认为 0 时放行任意大小（对应发送端整条 WS 消息的放行规则）
    if (this.#outstanding > 0 && this.#outstanding + bytes > this.#initial) return false;
    this.#outstanding += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#outstanding = Math.max(0, this.#outstanding - bytes);
  }
}
