// daemon HTTP / WS 客户端（字段见 docs/api-contract.md）。

import WebSocket from "ws";

export type SessionStatus = "idle" | "terminal-driving" | "daemon-driving";

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  projectDirName: string;
  title: string;
  lastPreview: string;
  lastActiveAt: number;
  sizeBytes: number;
  status: SessionStatus;
}

export interface SearchMatch {
  field: "title" | "cwd" | "preview" | "content";
  snippet: string;
  seq?: number;
}

export interface SearchResultItem extends SessionSummary {
  match: SearchMatch;
}

export interface RenderMessage {
  seq: number;
  blockIndex: number;
  uuid: string;
  role: "user" | "assistant";
  kind: "text" | "tool_use" | "tool_result" | "thinking" | "meta";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  timestamp?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface ApprovalCard {
  interactionId: string;
  sessionId: string;
  kind: "approval" | "question";
  toolName: string;
  input: Record<string, unknown>;
  prompt: string;
  expiresAt: number;
  questions?: QuestionItem[];
}

export type Decision =
  | { type: "allow_once" }
  | { type: "deny"; message?: string }
  | { type: "answer"; answers: Record<string, string> };

export type ServerFrame =
  | { type: "message"; sessionId: string; message: RenderMessage }
  | { type: "resync"; sessionId: string }
  | { type: "status"; sessionId: string; status: SessionStatus }
  | { type: "run"; sessionId: string; runId: string; state: "started" | "done" | "error"; error?: string }
  | { type: "approval"; interaction: ApprovalCard }
  | { type: "approval.resolved"; interactionId: string; status: string };

/** relay connector 状态（daemon /api/connect-info 的 relays 字段）。 */
export interface RelayStatus {
  state: "disabled" | "connecting" | "connected" | "error";
  error?: string;
  base?: string;
  since?: number;
}

export interface ConnectInfo {
  bases: string[];
  relays: RelayStatus[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status} ${code}`);
  }
}

export class Api {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly timeoutMs = 8000,
  ) {}

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const code = (parsed as { error?: unknown }).error;
      throw new ApiError(res.status, typeof code === "string" ? code : "http_error");
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; version: string; claudeCliVersion: string }> {
    return this.#request("GET", "/api/health");
  }

  connectInfo(): Promise<ConnectInfo> {
    return this.#request("GET", "/api/connect-info");
  }

  async sessions(limit = 200): Promise<{ sessions: SessionSummary[]; total: number }> {
    return this.#request("GET", `/api/sessions?limit=${limit}`);
  }

  async search(q: string, full = false, limit = 50): Promise<{ results: SearchResultItem[]; truncated: boolean }> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (full) params.set("full", "1");
    return this.#request("GET", `/api/sessions/search?${params.toString()}`);
  }

  async messages(sessionId: string, limit = 50): Promise<{ messages: RenderMessage[]; hasMore: boolean }> {
    return this.#request("GET", `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`);
  }

  send(sessionId: string, text: string): Promise<{ runId: string }> {
    return this.#request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text });
  }

  abort(sessionId: string): Promise<unknown> {
    return this.#request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/abort`, {});
  }

  async pending(): Promise<ApprovalCard[]> {
    const body = await this.#request<{ interactions: ApprovalCard[] }>("GET", "/api/interactions/pending");
    return body.interactions;
  }

  decide(interactionId: string, decision: Decision): Promise<{ status: string }> {
    return this.#request("POST", `/api/interactions/${encodeURIComponent(interactionId)}/decision`, decision);
  }
}

export interface EventStream {
  subscribe(sessionId: string): void;
  unsubscribe(sessionId: string): void;
  close(): void;
}

/** WS 事件流：断线指数退避重连，重连后自动重新订阅。 */
export function connectEvents(
  baseUrl: string,
  token: string,
  handlers: { onFrame: (frame: ServerFrame) => void; onConnection?: (up: boolean) => void },
): EventStream {
  const subs = new Set<string>(["*"]);
  let ws: WebSocket | undefined;
  let closed = false;
  let backoff = 500;
  let timer: NodeJS.Timeout | undefined;
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

  const send = (frame: unknown): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  const open = (): void => {
    if (closed) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.on("open", () => {
      backoff = 500;
      handlers.onConnection?.(true);
      for (const id of subs) send({ type: "subscribe", sessionId: id });
    });
    socket.on("message", (data) => {
      try {
        handlers.onFrame(JSON.parse(data.toString()) as ServerFrame);
      } catch {
        // 忽略坏帧
      }
    });
    socket.on("error", () => {
      // close 事件里统一重连
    });
    socket.on("close", () => {
      handlers.onConnection?.(false);
      if (closed) return;
      timer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    });
  };
  open();

  return {
    subscribe(id) {
      subs.add(id);
      send({ type: "subscribe", sessionId: id });
    },
    unsubscribe(id) {
      if (id === "*") return;
      subs.delete(id);
      send({ type: "unsubscribe", sessionId: id });
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      ws?.close();
    },
  };
}
