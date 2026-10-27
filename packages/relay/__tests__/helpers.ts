// 测试辅助：真实 relay + 直接用 protocol 模块写的假 agent。

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { WebSocket } from "ws";

import {
  DataType,
  encodeControl,
  encodeData,
  parseControl,
  parseData,
  type ControlFrame,
  type DataFrame,
  type HttpOpenFrame,
} from "../src/protocol.js";
import { startRelay, type RelayHandle, type RelayOptions } from "../src/server.js";

export const SECRET = "test-secret-0123456789-abcdefghijklmnop";
export const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** python3: base32(sha256("claude-remote-relay/v1:" + KEY_A)).lower()[:20] */
export const ID_A = "bzbptgnfvedw5f5bhwow";

export interface TestRelay {
  relay: RelayHandle;
  base: string;
  logs: string[];
}

export async function startTestRelay(overrides: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const logs: string[] = [];
  const relay = await startRelay({
    secret: SECRET,
    host: "127.0.0.1",
    port: 0,
    maxStreams: 64,
    maxBodyBytes: 25 * 1024 * 1024,
    version: "test",
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { relay, base: `http://127.0.0.1:${relay.port}`, logs };
}

export type AgentEvent = { kind: "control"; frame: ControlFrame } | { kind: "data"; frame: DataFrame };

export class FakeAgent {
  readonly events: AgentEvent[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** 收到数据帧后立即回 credit，模拟及时消费的 daemon。 */
  autoCredit = true;
  readonly #handlers: ((event: AgentEvent) => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on("message", (data, isBinary) => {
      const buf = data as Buffer;
      let event: AgentEvent;
      if (isBinary) {
        const parsed = parseData(buf);
        if (!parsed.ok) throw new Error(`relay sent bad data frame: ${parsed.error}`);
        event = { kind: "data", frame: parsed.frame };
        if (this.autoCredit) this.send({ t: "credit", sid: parsed.frame.sid, bytes: parsed.frame.payload.length });
      } else {
        const parsed = parseControl(buf.toString());
        if (!parsed.ok) throw new Error(`relay sent bad control frame: ${parsed.error}`);
        event = { kind: "control", frame: parsed.frame };
      }
      this.events.push(event);
      for (const handler of this.#handlers) handler(event);
    });
  }

  static connect(
    port: number,
    key: string,
    opts: { id?: string; secret?: string } = {},
  ): Promise<FakeAgent> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
        headers: {
          Authorization: `Bearer ${opts.secret ?? SECRET}`,
          "X-Device-Id": opts.id ?? ID_A,
          "X-Device-Key": key,
        },
      });
      ws.once("open", () => resolve(new FakeAgent(ws)));
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => reject(Object.assign(new Error(`agent rejected ${res.statusCode}`), { status: res.statusCode, body })));
      });
      ws.once("error", (error) => reject(error));
    });
  }

  on(handler: (event: AgentEvent) => void): void {
    this.#handlers.push(handler);
  }

  send(frame: ControlFrame): void {
    this.ws.send(encodeControl(frame));
  }

  sendData(type: DataType, sid: number, payload: Buffer | string): void {
    this.ws.send(encodeData(type, sid, typeof payload === "string" ? Buffer.from(payload) : payload));
  }

  /** 等一个满足条件的事件（含已收到的）。 */
  waitFor(pred: (event: AgentEvent) => boolean, timeoutMs = 3000): Promise<AgentEvent> {
    const found = this.events.find(pred);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
      this.on((event) => {
        if (pred(event)) {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }

  waitControl<T extends ControlFrame["t"]>(t: T, sid?: number, timeoutMs?: number): Promise<Extract<ControlFrame, { t: T }>> {
    return this.waitFor(
      (e) => e.kind === "control" && e.frame.t === t && (sid === undefined || e.frame.sid === sid),
      timeoutMs,
    ).then((e) => e.frame as Extract<ControlFrame, { t: T }>);
  }

  bodyBytes(sid: number): number {
    let n = 0;
    for (const e of this.events) if (e.kind === "data" && e.frame.sid === sid) n += e.frame.payload.length;
    return n;
  }

  /** 简易 daemon：收完请求体后回 200 JSON 回显。 */
  serveEcho(): void {
    const bodies = new Map<number, { open: HttpOpenFrame; chunks: Buffer[] }>();
    this.on((event) => {
      if (event.kind === "data") {
        bodies.get(event.frame.sid)?.chunks.push(event.frame.payload);
        return;
      }
      const frame = event.frame;
      if (frame.t === "open" && frame.kind === "http") bodies.set(frame.sid, { open: frame, chunks: [] });
      if (frame.t === "end") {
        const entry = bodies.get(frame.sid);
        if (entry === undefined) return;
        bodies.delete(frame.sid);
        const { open } = entry;
        const body = JSON.stringify({
          method: open.method,
          path: open.path,
          headers: open.headers,
          remote: open.remote,
          body: Buffer.concat(entry.chunks).toString(),
        });
        this.send({ t: "head", sid: frame.sid, status: 200, headers: { "content-type": "application/json", "x-echo": "1" } });
        this.sendData(DataType.HttpBody, frame.sid, body);
        this.send({ t: "end", sid: frame.sid });
      }
    });
  }

  close(): void {
    this.ws.close();
  }
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json(): Record<string, unknown>;
}

export function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: opts.method ?? "GET", headers: opts.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString()) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件成立。 */
export async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until timed out");
    await delay(10);
  }
}

/** 以手机身份连 WS；被拒时 reject 的错误带 status。 */
export function wsConnect(url: string): Promise<WebSocket> {
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

export function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data: data as Buffer, isBinary })));
}

export function closeEvent(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}
