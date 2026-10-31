// HTTP + WebSocket 服务层。
//
// 职责：Bearer/token 鉴权、HTTP 端点映射（NotIdleError→409、already_resolved→409、
// ENOENT→404）、WS subscribe 管理与广播、watcher/activity/runner/
// approval 事件 → WS 帧、notifier 触发（审批创建、run 终态）。
//
// 广播语义：message/resync/run 只发给订阅了该会话的连接；status 另发给订阅 "*"
// 的连接；approval / approval.resolved 广播给全部已鉴权连接（前端按 interactionId
// 匹配，见 05 报告对表第 4 条）。

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";

import { EFFORT_LEVELS, type EffortLevel } from "@claude-remote/agent-bridge";
import { readEffortOptions, type EffortOptions } from "./effort-levels.js";
import type { DaemonConfig } from "./config.js";
import { isLoopbackAddress, looksProxied, pairBases, pairPayload, type PairInfo } from "./pair.js";
import { isKnownModel, readModelCatalog, type ModelCatalog } from "./model-config.js";
import { readSessionCwd, resolveSessionFile } from "./session-files.js";
import { StreamBuffer } from "./run/stream-buffer.js";
import { approvalLink, NotIdleError, sessionLink, type ApprovalBridge, type ApprovalEvent, type Notifier, type TurnHandle, type TurnRunner } from "./run/index.js";
import { listSessions } from "./transcript/indexer.js";
import { buildProjectIndex } from "./transcript/projects.js";
import { readBefore, readTail } from "./transcript/reader.js";
import { searchSessions } from "./transcript/search.js";
import type { ActivityTracker } from "./watch/activity.js";
import type { SessionWatcher } from "./watch/watcher.js";


const BODY_LIMIT_BYTES = 1024 * 1024;
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif",
};
const MESSAGES_LIMIT_DEFAULT = 100;
const MESSAGES_LIMIT_MAX = 500;
const WS_HEARTBEAT_MS = 30_000;

const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface DaemonServerOptions {
  config: DaemonConfig;
  watcher: SessionWatcher;
  tracker: ActivityTracker;
  runner: TurnRunner;
  approvals: ApprovalBridge;
  notifier: Notifier;
  version: string;
  /** 返回启动时探测的 claude CLI 版本（未就绪/失败时 "unknown"）。 */
  claudeCliVersion: () => string;
  /** 测试/嵌入方可注入；默认每次请求重新读取 Mac 设置，以反映即时切换。 */
  modelCatalog?: () => Promise<ModelCatalog>;
  effortOptions?: (cwd: string, model?: string) => Promise<EffortOptions>;
  /** relay connector 只读状态；缺省视为未启用。 */
  relayStatuses?: () => RelayStatus[];
}

export interface RelayStatus {
  state: "disabled" | "connecting" | "connected" | "error";
  error?: string;
  /** relay 启用时手机可用的 base（`${RELAY_URL}/d/<deviceId>`），追加在直连地址之后。 */
  base?: string;
  since?: number;
}

interface ClientState {
  subs: Set<string>;
  alive: boolean;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class DaemonServer {
  readonly #options: DaemonServerOptions;
  #pairPort: number;
  readonly #tokenHash: Buffer;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #clients = new Map<WebSocket, ClientState>();
  readonly #watchRefs = new Map<string, number>();
  readonly #activeRuns = new Map<string, TurnHandle>();
  readonly #newSessions = new Set<string>();
  readonly #messageRequests = new Map<string, { sessionId: string; runId: string; clientMessageId: string; expiresAt: number }>();
  readonly #watchActivations = new Set<string>();
  readonly #watchRetryTimers = new Map<string, NodeJS.Timeout>();
  readonly #streams = new StreamBuffer({ emit: (frame) => this.#broadcastToSubscribers(frame.sessionId, frame) });
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: DaemonServerOptions) {
    this.#options = options;
    this.#pairPort = options.config.port;
    this.#tokenHash = sha256(options.config.token);
    this.#http = createServer((req, res) => {
      void this.#handleRequest(req, res).catch((error) => {
        console.error("request handler failed:", error);
        if (!res.headersSent) this.#json(res, 500, { error: "internal" });
        else res.destroy();
      });
    });
    this.#wss = new WebSocketServer({ noServer: true });
    this.#http.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.#wireEvents();
  }

  /** 监听端口。 */
  listen(): Promise<void> {
    const { host, port } = this.#options.config;
    return new Promise((resolvePromise, rejectPromise) => {
      this.#http.once("error", rejectPromise);
      this.#http.listen(port, host, () => {
        this.#http.off("error", rejectPromise);
        this.#pairPort = this.address().port;
        this.#heartbeat = setInterval(() => this.#pingClients(), WS_HEARTBEAT_MS);
        this.#heartbeat.unref();
        resolvePromise();
      });
    });
  }

  /** 配对信息（候选地址每次现查——Tailscale 可能在 daemon 启动后才拉起）；listen() 后用实际端口。 */
  get pairInfo(): PairInfo {
    const { token } = this.#options.config;
    const relayBases = (this.#options.relayStatuses?.() ?? []).flatMap((relay) => relay.base === undefined ? [] : [relay.base]);
    return { bases: pairBases(this.#pairPort, relayBases), token };
  }

  /** 实际监听地址（测试用 port 0）。 */
  address(): { host: string; port: number } {
    const addr = this.#http.address();
    if (addr === null || typeof addr === "string") throw new Error("server not listening");
    return { host: addr.address, port: addr.port };
  }

  /** ApprovalBridge onEvent 接线入口：广播 + 审批创建通知。 */
  handleApprovalEvent(event: ApprovalEvent): void {
    this.#broadcastAll(event);
    if (event.type === "approval") {
      const card = event.interaction;
      const what = card.kind === "approval" ? `${card.toolName}: ${card.prompt}` : `提问：${card.questions?.[0]?.question ?? ""}`;
      void this.#options.notifier(card.kind === "approval" ? "Claude 待审批" : "Claude 有问题要问你", what.slice(0, 120), {
        url: approvalLink(card.interactionId, card.sessionId),
        group: "approval",
        urgent: true,
      });
    }
  }

  /** 优雅退出：停收新连接、关 WS、abort 活跃 run 并等 settle。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    for (const timer of this.#watchRetryTimers.values()) clearTimeout(timer);
    this.#watchRetryTimers.clear();
    for (const socket of this.#clients.keys()) socket.close(1001, "server shutdown");
    const completions = [...this.#activeRuns.values()].map((handle) => handle.completion);
    for (const runId of this.#activeRuns.keys()) this.#options.runner.abort(runId);
    await Promise.allSettled(completions);
    this.#wss.close();
    await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
  }

  // -- 鉴权 -------------------------------------------------------------------

  #tokenOk(candidate: string | undefined): boolean {
    if (candidate === undefined || candidate === "") return false;
    return timingSafeEqual(sha256(candidate), this.#tokenHash);
  }

  #bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    return this.#tokenOk(header.slice("Bearer ".length).trim());
  }

  // -- HTTP -------------------------------------------------------------------

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      // 保留 API 跨域兼容；鉴权使用 Bearer token。
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }
      // 配对路由不走 Bearer：token 本身就是它要下发的内容，改用 loopback-only 门禁。
      if (path === "/api/pair-info" || path === "/api/pair-qr.svg") {
        await this.#handlePair(req, res, path);
        return;
      }
      if (!this.#bearerOk(req)) {
        this.#json(res, 401, { error: "unauthorized" });
        return;
      }
      await this.#handleApi(req, res, url);
      return;
    }
    this.#json(res, 404, { error: "not_found" });
  }

  async #handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { method } = req;
    const path = url.pathname;

    if (method === "GET" && path === "/api/health") {
      this.#json(res, 200, {
        ok: true,
        version: this.#options.version,
        claudeCliVersion: this.#options.claudeCliVersion(),
        hostname: hostname(),
      });
      return;
    }

    if (method === "GET" && path === "/api/connect-info") {
      const relays = this.#options.relayStatuses?.() ?? [];
      const relayBases = relays.flatMap((relay) => relay.base === undefined ? [] : [relay.base]);
      this.#json(res, 200, { bases: pairBases(this.#pairPort, relayBases), relays });
      return;
    }

    if (method === "GET" && path === "/api/sessions") {
      await this.#handleListSessions(res, url);
      return;
    }

    if (method === "GET" && path === "/api/sessions/search") {
      await this.#handleSearch(res, url);
      return;
    }

    if (method === "GET" && path === "/api/interactions/pending") {
      this.#json(res, 200, { interactions: this.#options.approvals.pending() });
      return;
    }

    if (method === "GET" && path === "/api/projects") {
      const all = await listSessions(this.#options.config.projectsDir);
      this.#json(res, 200, { ...(await buildProjectIndex(all)).catalog, homeCwd: homedir() });
      return;
    }

    if (method === "GET" && path === "/api/models") {
      this.#json(res, 200, await this.#readModelCatalog());
      return;
    }

    if (method === "GET" && path === "/api/effort-levels") {
      await this.#handleEffortLevels(res, url);
      return;
    }

    if (method === "POST" && path === "/api/sessions") {
      await this.#handleCreateSession(req, res);
      return;
    }

    const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/.exec(path);
    if (abortMatch !== null && method === "POST") {
      await this.#handleAbort(req, res, decodeURIComponent(abortMatch[1] ?? ""));
      return;
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch !== null) {
      const sessionId = decodeURIComponent(messagesMatch[1] ?? "");
      if (method === "GET") {
        await this.#handleGetMessages(res, url, sessionId);
        return;
      }
      if (method === "POST") {
        await this.#handlePostMessage(req, res, sessionId);
        return;
      }
    }

    if (method === "POST" && path === "/api/upload") {
      // 会话尚未创建时的附件上传（新建会话先传附件、路径随首条消息一起发）
      await this.#saveUpload(req, res, url, "new");
      return;
    }
    const imageMatch = /^\/api\/sessions\/([^/]+)\/file$/.exec(path);
    if (imageMatch !== null && method === "GET") {
      await this.#serveSessionImage(res, url, decodeURIComponent(imageMatch[1] ?? ""));
      return;
    }

    const uploadMatch = /^\/api\/sessions\/([^/]+)\/upload$/.exec(path);
    if (uploadMatch !== null && method === "POST") {
      await this.#handleUpload(req, res, url, decodeURIComponent(uploadMatch[1] ?? ""));
      return;
    }

    const uploadFileMatch = /^\/api\/uploads\/([^/]+)\/([^/]+)$/.exec(path);
    if (uploadFileMatch !== null && method === "GET") {
      await this.#serveUpload(res, decodeURIComponent(uploadFileMatch[1] ?? ""), decodeURIComponent(uploadFileMatch[2] ?? ""));
      return;
    }

    const decisionMatch = /^\/api\/interactions\/([^/]+)\/decision$/.exec(path);
    if (decisionMatch !== null && method === "POST") {
      await this.#handleDecision(req, res, decodeURIComponent(decisionMatch[1] ?? ""));
      return;
    }

    this.#json(res, 404, { error: "not_found" });
  }

  /** loopback-only 配对端点：pair-info 返回候选地址与 token，pair-qr.svg 返回二维码。 */
  async #handlePair(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress) || looksProxied(req.headers)) {
      this.#json(res, 403, { error: "loopback_only" });
      return;
    }
    if (req.method !== "GET") {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    if (path === "/api/pair-info") {
      this.#json(res, 200, this.pairInfo);
      return;
    }
    const svg = await QRCode.toString(pairPayload(this.pairInfo), { type: "svg" });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    res.end(svg);
  }

  async #handleListSessions(res: ServerResponse, url: URL): Promise<void> {
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const all = await listSessions(this.#options.config.projectsDir);
    const projectId = url.searchParams.get("projectId");
    const cwd = url.searchParams.get("cwd");
    let filtered = cwd === null ? all : all.filter((summary) => summary.cwd === cwd);
    if (projectId === "") {
      filtered = filtered.filter((summary) => summary.cwd === "");
    } else if (projectId !== null) {
      const { projectIdByCwd } = await buildProjectIndex(all);
      filtered = filtered.filter((summary) => projectIdByCwd.get(summary.cwd) === projectId);
    }
    const sessions = filtered.slice(offset, offset + limit).map((summary) => ({
      ...summary,
      status: this.#options.tracker.getStatus(summary.sessionId),
    }));
    this.#json(res, 200, { sessions, total: filtered.length });
  }

  async #handleSearch(res: ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (q.trim() === "") {
      this.#json(res, 400, { error: "invalid_query" });
      return;
    }
    const full = url.searchParams.get("full") === "1" || url.searchParams.get("full") === "true";
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const all = await listSessions(this.#options.config.projectsDir);
    const { hits, truncated } = await searchSessions(this.#options.config.projectsDir, all, q, { full, limit });
    this.#json(res, 200, {
      results: hits.map((hit) => ({
        ...hit.session,
        status: this.#options.tracker.getStatus(hit.session.sessionId),
        match: { field: hit.field, snippet: hit.snippet, ...(hit.seq === undefined ? {} : { seq: hit.seq }) },
      })),
      truncated,
    });
  }

  async #readModelCatalog(): Promise<ModelCatalog> {
    return this.#options.modelCatalog?.() ?? readModelCatalog();
  }

  async #knownCwds(): Promise<Set<string>> {
    const sessions = await listSessions(this.#options.config.projectsDir);
    return new Set([...sessions.map((session) => session.cwd).filter((cwd) => cwd !== ""), homedir()]);
  }

  async #validateModel(
    res: ServerResponse,
    value: unknown,
  ): Promise<string | undefined | false> {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      this.#json(res, 400, { error: "invalid_model" });
      return false;
    }
    const model = value.trim();
    if (!isKnownModel(await this.#readModelCatalog(), model)) {
      this.#json(res, 400, { error: "unknown_model" });
      return false;
    }
    return model;
  }

  /** 校验 permissionMode 白名单；省略 -> undefined，非法 -> 400 false。 */
  #validatePermissionMode(res: ServerResponse, value: unknown): PermissionMode | undefined | false {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !VALID_PERMISSION_MODES.has(value)) {
      this.#json(res, 400, { error: "invalid_permission_mode" });
      return false;
    }
    return value as PermissionMode;
  }

  async #handleEffortLevels(res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    let cwd: string;
    if (sessionId !== null) {
      if (!isUuid(sessionId)) { this.#json(res, 400, { error: "invalid_session_id" }); return; }
      try { cwd = (await readSessionCwd(await resolveSessionFile(this.#options.config.projectsDir, sessionId))) || homedir(); }
      catch (error) {
        if (isEnoent(error)) { this.#json(res, 404, { error: "session_not_found" }); return; }
        throw error;
      }
    } else {
      cwd = url.searchParams.get("cwd")?.trim() || homedir();
      if (!(await this.#knownCwds()).has(cwd)) { this.#json(res, 400, { error: "unknown_cwd" }); return; }
    }
    const model = await this.#validateModel(res, url.searchParams.get("model") ?? undefined);
    if (model === false) return;
    this.#json(res, 200, await (this.#options.effortOptions ?? readEffortOptions)(cwd, model));
  }

  #validateEffort(res: ServerResponse, value: unknown): EffortLevel | undefined | false {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !EFFORT_LEVELS.includes(value as EffortLevel)) {
      this.#json(res, 400, { error: "invalid_effort" }); return false;
    }
    return value as EffortLevel;
  }

  #clientMessageId(res: ServerResponse, body: unknown): string | undefined | false {
    const id = (body as Record<string, unknown>).clientMessageId;
    if (id === undefined) return undefined;
    if (typeof id !== "string" || !isUuid(id)) {
      this.#json(res, 400, { error: "invalid_client_message_id" });
      return false;
    }
    return id.toLowerCase();
  }

  #repeatMessage(res: ServerResponse, scope: string, id: string | undefined): boolean {
    const now = Date.now();
    for (const [key, entry] of this.#messageRequests) {
      if (entry.expiresAt <= now) this.#messageRequests.delete(key);
    }
    if (id === undefined) return false;
    const previous = this.#messageRequests.get(`${scope}:${id}`);
    if (!previous) return false;
    this.#json(res, 202, { sessionId: previous.sessionId, runId: previous.runId, clientMessageId: id, replayed: true });
    return true;
  }

  #rememberMessage(scope: string, sessionId: string, runId: string, id: string | undefined): void {
    if (id !== undefined) this.#messageRequests.set(`${scope}:${id}`, {
      sessionId, runId, clientMessageId: id, expiresAt: Date.now() + 10 * 60_000,
    });
  }

  async #handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const clientMessageId = this.#clientMessageId(res, body);
    if (clientMessageId === false || this.#repeatMessage(res, "new", clientMessageId)) return;
    const { cwd: cwdValue, text: textValue, model: modelValue, permissionMode: permModeValue } = body as Record<string, unknown>;
    if (typeof cwdValue !== "string" || cwdValue.trim() === "") {
      this.#json(res, 400, { error: "invalid_cwd" });
      return;
    }
    if (typeof textValue !== "string" || textValue.trim() === "") {
      this.#json(res, 400, { error: "invalid_text" });
      return;
    }
    const cwd = cwdValue.trim();
    if (!(await this.#knownCwds()).has(cwd)) {
      this.#json(res, 400, { error: "unknown_cwd" });
      return;
    }
    const model = await this.#validateModel(res, modelValue);
    if (model === false) return;
    const permissionMode = this.#validatePermissionMode(res, permModeValue);
    if (permissionMode === false) return;

    const effort = this.#validateEffort(res, (body as Record<string, unknown>).effort);
    if (effort === false) return;
    if (this.#repeatMessage(res, "new", clientMessageId)) return;

    const sessionId = randomUUID();
    let handle: TurnHandle;
    try {
      handle = this.#options.runner.startTurn({
        sessionId,
        cwd,
        text: textValue,
        newSession: true,
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
    } catch (error) {
      if (error instanceof NotIdleError) {
        this.#json(res, 409, { error: "not_idle", status: this.#options.tracker.getStatus(sessionId) });
        return;
      }
      if (error instanceof TypeError) {
        this.#json(res, 400, { error: "invalid_text" });
        return;
      }
      throw error;
    }
    this.#newSessions.add(sessionId);
    this.#activeRuns.set(handle.runId, handle);
    this.#rememberMessage("new", sessionId, handle.runId, clientMessageId);
    void this.#pumpRun(sessionId, textValue, handle);
    this.#json(res, 202, { sessionId, runId: handle.runId, ...(clientMessageId === undefined ? {} : { clientMessageId }) });
  }

  async #handleAbort(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) {
      this.#json(res, 400, { error: "invalid_session_id" });
      return;
    }
    const body = await this.#readJsonBody(req, res, true);
    if (body === undefined) return;
    const requestedRunId = (body as { runId?: unknown }).runId;
    if (requestedRunId !== undefined && (typeof requestedRunId !== "string" || !isUuid(requestedRunId))) {
      this.#json(res, 400, { error: "invalid_run_id" });
      return;
    }
    const activeRunId = this.#options.runner.activeRunId(sessionId);
    if (requestedRunId !== undefined && activeRunId === undefined) {
      this.#json(res, 200, {
        runId: null,
        status: "idle",
        sessionStatus: this.#options.tracker.getStatus(sessionId),
      });
      return;
    }
    if (requestedRunId !== undefined && requestedRunId !== activeRunId) {
      this.#json(res, 409, { error: "run_mismatch", activeRunId, status: "daemon-driving" });
      return;
    }
    if (activeRunId === undefined) {
      // 未指定 runId 时保留旧客户端的手动解除占用入口；指定 runId 的幂等停止不得经过这里
      const released = this.#options.tracker.release(sessionId);
      this.#json(res, 200, { runId: null, status: released ? "released" : "idle" });
      return;
    }
    this.#options.runner.abort(activeRunId);
    this.#json(res, 200, { runId: activeRunId, status: "aborted" });
  }

  async #handleGetMessages(res: ServerResponse, url: URL, sessionId: string): Promise<void> {
    let file: string;
    try {
      file = await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    const limit = clampInt(url.searchParams.get("limit"), MESSAGES_LIMIT_DEFAULT, 1, MESSAGES_LIMIT_MAX);
    const beforeSeqRaw = url.searchParams.get("beforeSeq");
    const beforeSeq = beforeSeqRaw === null || beforeSeqRaw === "" ? undefined : Number(beforeSeqRaw);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      this.#json(res, 400, { error: "invalid_before_seq" });
      return;
    }
    try {
      const page = beforeSeq === undefined ? await readTail(file, limit) : await readBefore(file, beforeSeq, limit);
      this.#json(res, 200, { messages: page.messages, firstSeq: page.firstSeq, hasMore: page.hasMore });
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
  }

  async #handlePostMessage(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const clientMessageId = this.#clientMessageId(res, body);
    if (clientMessageId === false || this.#repeatMessage(res, sessionId, clientMessageId)) return;
    const text = (body as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim() === "") {
      this.#json(res, 400, { error: "invalid_text" });
      return;
    }
    const model = await this.#validateModel(res, (body as { model?: unknown }).model);
    if (model === false) return;
    const permissionMode = this.#validatePermissionMode(res, (body as { permissionMode?: unknown }).permissionMode);
    if (permissionMode === false) return;
    let file: string;
    try {
      file = await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    const cwd = (await readSessionCwd(file)) || homedir();
    const effort = this.#validateEffort(res, (body as Record<string, unknown>).effort);
    if (effort === false) return;
    if (this.#repeatMessage(res, sessionId, clientMessageId)) return;
    let handle: TurnHandle;
    try {
      handle = this.#options.runner.startTurn({
        sessionId,
        cwd,
        text,
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
    } catch (error) {
      if (error instanceof NotIdleError) {
        this.#json(res, 409, { error: "not_idle", status: this.#options.tracker.getStatus(sessionId) });
        return;
      }
      if (error instanceof TypeError) {
        this.#json(res, 400, { error: "invalid_text" });
        return;
      }
      throw error;
    }
    this.#activeRuns.set(handle.runId, handle);
    this.#rememberMessage(sessionId, sessionId, handle.runId, clientMessageId);
    void this.#pumpRun(sessionId, text, handle);
    this.#json(res, 202, { runId: handle.runId, ...(clientMessageId === undefined ? {} : { clientMessageId }) });
  }

  /** 消费 run 事件流：run 帧 → 订阅者；终态 → notifier。message 帧走 watcher，不在此转发。 */
  async #pumpRun(sessionId: string, text: string, handle: TurnHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (event.type === "worker") {
          const worker = event.event;
          if (this.#newSessions.has(sessionId) && worker.type === "session") {
            void this.#activateNewSessionWatch(sessionId);
          } else if (worker.type === "assistant_stream_start") {
            this.#streams.start(sessionId, worker.apiMessageId);
          } else if (worker.type === "assistant_delta") {
            this.#streams.delta(sessionId, worker.index ?? 0, worker.text);
          } else if (worker.type === "assistant_block_stop") {
            this.#streams.stop(sessionId, worker.index);
          }
          continue;
        }
        if (event.state !== "started") this.#streams.end(sessionId);
        const frame: Record<string, unknown> = {
          type: "run",
          sessionId,
          runId: event.runId,
          state: event.state,
        };
        if (event.error !== undefined) frame.error = event.error;
        if (event.permissionMode !== undefined) frame.permissionMode = event.permissionMode;
        this.#broadcastToSubscribers(sessionId, frame);
        if (event.state === "done") {
          void this.#options.notifier("Claude 已完成", snippet(text), { url: sessionLink(sessionId), group: "run" });
        } else if (event.state === "error") {
          void this.#options.notifier("Claude 运行出错", `${event.error ?? "unknown"} · ${snippet(text)}`, {
            url: sessionLink(sessionId),
            group: "run",
          });
        }
      }
    } catch (error) {
      console.error(`run event pump failed (session ${sessionId}):`, error);
    } finally {
      this.#activeRuns.delete(handle.runId);
      this.#streams.end(sessionId);
      if (this.#newSessions.has(sessionId)) void this.#activateNewSessionWatch(sessionId);
    }
  }

  async #serveSessionImage(res: ServerResponse, url: URL, sessionId: string): Promise<void> {
    let sessionFile: string;
    try {
      sessionFile = await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      this.#json(res, 404, { error: "session_not_found" });
      return;
    }
    const requested = url.searchParams.get("path");
    if (!requested || requested.includes("\0")) {
      this.#json(res, 400, { error: "invalid_path" });
      return;
    }
    let target = requested;
    if (target.startsWith("file:")) {
      try { target = fileURLToPath(target); }
      catch {
        this.#json(res, 400, { error: "invalid_path" });
        return;
      }
    } else if (target.startsWith("~/")) {
      target = join(homedir(), target.slice(2));
    } else if (!isAbsolute(target)) {
      target = resolve((await readSessionCwd(sessionFile)) || homedir(), target);
    }
    try {
      target = await realpath(target);
      const types: Record<string, string> = { ...IMAGE_TYPES, bmp: "image/bmp", avif: "image/avif" };
      const type = types[extname(target).slice(1).toLowerCase()];
      if (type === undefined) {
        this.#json(res, 415, { error: "unsupported_image" });
        return;
      }
      const info = await stat(target);
      if (!info.isFile()) {
        this.#json(res, 404, { error: "not_found" });
        return;
      }
      if (info.size > UPLOAD_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return;
      }
      const data = await readFile(target);
      if (data.length > UPLOAD_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": data.length,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "ELOOP") throw error;
      this.#json(res, 404, { error: "not_found" });
    }
  }

  /** 上传附件：raw body + ?filename=，按 sessionId 分目录落盘，返回 Mac 上的绝对路径。 */
  async #handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string): Promise<void> {
    try {
      await resolveSessionFile(this.#options.config.projectsDir, sessionId);
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "session_not_found" });
        return;
      }
      throw error;
    }
    await this.#saveUpload(req, res, url, sessionId);
  }

  /** 附件落盘公共逻辑：raw body + ?filename=，存入 uploadsDir/<subdir>/，返回绝对路径。 */
  async #saveUpload(req: IncomingMessage, res: ServerResponse, url: URL, subdir: string): Promise<void> {
    // 文件名只取 basename 并过滤路径分隔符/控制字符，防目录穿越
    const rawName = url.searchParams.get("filename") ?? "";
    const safeName = (basename(rawName).replace(/[\/\\]/g, "_").replace(/[^\P{C}]/gu, "").trim() || "file");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > UPLOAD_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    if (size === 0) {
      this.#json(res, 400, { error: "empty_file" });
      return;
    }
    const dir = join(this.#options.config.uploadsDir, subdir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${safeName}`);
    await writeFile(file, Buffer.concat(chunks));
    this.#json(res, 200, { path: file, name: safeName, sizeBytes: size });
  }

  /** 回读已上传的图片，供手机在消息里显示。只认 uploadsDir/<subdir>/<name> 两级，且只给图片。 */
  async #serveUpload(res: ServerResponse, subdir: string, name: string): Promise<void> {
    const type = IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
    const unsafe = (s: string) => !s || s === "." || s === ".." || /[\/\\\0]/.test(s);
    if (unsafe(subdir) || unsafe(name) || type === undefined) {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    let data: Buffer;
    try {
      data = await readFile(join(this.#options.config.uploadsDir, subdir, name));
    } catch (error) {
      if (isEnoent(error)) {
        this.#json(res, 404, { error: "not_found" });
        return;
      }
      throw error;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "private, max-age=31536000, immutable" });
    res.end(data);
  }

  async #handleDecision(req: IncomingMessage, res: ServerResponse, interactionId: string): Promise<void> {
    const body = await this.#readJsonBody(req, res);
    if (body === undefined) return;
    const outcome = this.#options.approvals.decide(interactionId, body as never);
    switch (outcome.status) {
      case "allowed":
      case "denied":
      case "answered":
        this.#json(res, 200, { status: outcome.status });
        return;
      case "not_found":
        this.#json(res, 404, { error: "not_found" });
        return;
      case "already_resolved":
        this.#json(res, 409, { error: "already_resolved" });
        return;
      case "invalid":
        this.#json(res, 400, { error: "invalid", message: outcome.message });
        return;
    }
  }

  async #readJsonBody(req: IncomingMessage, res: ServerResponse, allowEmpty = false): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT_BYTES) {
        this.#json(res, 413, { error: "payload_too_large" });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
      if (allowEmpty) return {};
      this.#json(res, 400, { error: "invalid_json" });
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        this.#json(res, 400, { error: "invalid_json" });
        return undefined;
      }
      return parsed;
    } catch {
      this.#json(res, 400, { error: "invalid_json" });
      return undefined;
    }
  }

  #json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }


  // -- WebSocket --------------------------------------------------------------

  #handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== "/ws" || !this.#tokenOk(url.searchParams.get("token") ?? undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"unauthorized"}');
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#onConnection(ws);
    });
  }

  #onConnection(ws: WebSocket): void {
    const state: ClientState = { subs: new Set(), alive: true };
    this.#clients.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("message", (data) => {
      void this.#onClientFrame(ws, state, data.toString());
    });
    ws.on("close", () => {
      this.#clients.delete(ws);
      for (const sessionId of state.subs) this.#releaseWatch(sessionId);
    });
    ws.on("error", () => ws.terminate());
  }

  async #onClientFrame(ws: WebSocket, state: ClientState, raw: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const { type, sessionId } = frame as { type?: unknown; sessionId?: unknown };
    // 应用层心跳：RN 的 WebSocket 看不到协议层 ping，客户端靠 pong 判断半开连接
    if (type === "ping") {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (typeof sessionId !== "string" || sessionId === "") return;

    if (type === "subscribe") {
      if (state.subs.has(sessionId)) return;
      if (sessionId !== "*") {
        try {
          await this.#acquireWatch(sessionId);
          this.#newSessions.delete(sessionId);
        } catch (error) {
          if (isEnoent(error) && this.#newSessions.has(sessionId)) {
            state.subs.add(sessionId);
            this.#sendSessionState(ws, sessionId);
            void this.#activateNewSessionWatch(sessionId);
            return;
          }
          if (isEnoent(error)) return; // 未知会话：静默忽略（HTTP 侧已 404）
          console.warn(`watch(${sessionId}) failed:`, error);
          return;
        }
      }
      state.subs.add(sessionId);
      if (sessionId !== "*") this.#sendSessionState(ws, sessionId);
      // 中途打开 / 断线重连：补发正在流式输出的草稿
      for (const f of this.#streams.snapshot(sessionId)) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
      return;
    }
    if (type === "unsubscribe") {
      if (!state.subs.delete(sessionId)) return;
      if (sessionId !== "*") this.#releaseWatch(sessionId);
    }
  }

  #sendSessionState(ws: WebSocket, sessionId: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "session-state",
      sessionId,
      status: this.#options.tracker.getStatus(sessionId),
      activeRunId: this.#options.runner.activeRunId(sessionId) ?? null,
    }));
  }

  async #acquireWatch(sessionId: string): Promise<void> {
    if ((this.#watchRefs.get(sessionId) ?? 0) === 0) await this.#options.watcher.watch(sessionId);
    // watch() 是 async：并发 subscribe 会都走到这里，await 后重读计数防覆盖
    this.#watchRefs.set(sessionId, (this.#watchRefs.get(sessionId) ?? 0) + 1);
  }

  async #activateNewSessionWatch(sessionId: string): Promise<void> {
    if (this.#watchActivations.has(sessionId)) return;
    this.#watchActivations.add(sessionId);
    try {
      await this.#options.watcher.watch(sessionId);
      if (!this.#options.watcher.watched.includes(sessionId)) return;
      const refs = [...this.#clients.values()].filter((state) => state.subs.has(sessionId)).length;
      if (refs > 0) this.#watchRefs.set(sessionId, refs);
      else this.#options.watcher.unwatch(sessionId);
      this.#newSessions.delete(sessionId);
      const retry = this.#watchRetryTimers.get(sessionId);
      if (retry !== undefined) clearTimeout(retry);
      this.#watchRetryTimers.delete(sessionId);
      if (refs > 0) this.#broadcastToSubscribers(sessionId, { type: "resync", sessionId });
    } catch (error) {
      if (isEnoent(error)) this.#scheduleNewSessionWatchRetry(sessionId);
      else console.warn(`watch(${sessionId}) failed:`, error);
    } finally {
      this.#watchActivations.delete(sessionId);
    }
  }

  #scheduleNewSessionWatchRetry(sessionId: string): void {
    if (
      this.#closed
      || !this.#newSessions.has(sessionId)
      || this.#watchRetryTimers.has(sessionId)
      || ![...this.#clients.values()].some((state) => state.subs.has(sessionId))
    ) return;
    const timer = setTimeout(() => {
      this.#watchRetryTimers.delete(sessionId);
      void this.#activateNewSessionWatch(sessionId);
    }, 100);
    timer.unref();
    this.#watchRetryTimers.set(sessionId, timer);
  }

  #releaseWatch(sessionId: string): void {
    const refs = this.#watchRefs.get(sessionId) ?? 0;
    if (refs <= 1) {
      this.#watchRefs.delete(sessionId);
      this.#options.watcher.unwatch(sessionId);
      const retry = this.#watchRetryTimers.get(sessionId);
      if (retry !== undefined) clearTimeout(retry);
      this.#watchRetryTimers.delete(sessionId);
      return;
    }
    this.#watchRefs.set(sessionId, refs - 1);
  }

  #pingClients(): void {
    for (const [ws, state] of this.#clients) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  // -- 事件接线与广播 ---------------------------------------------------------

  #wireEvents(): void {
    const { watcher, tracker } = this.#options;
    watcher.on("message", (event) => {
      this.#broadcastToSubscribers(event.sessionId, {
        type: "message",
        sessionId: event.sessionId,
        message: event.message,
      });
    });
    watcher.on("resync", (event) => {
      this.#broadcastToSubscribers(event.sessionId, { type: "resync", sessionId: event.sessionId });
    });
    watcher.on("write", (event) => {
      tracker.noteWrite(event.sessionId, event.at);
    });
    watcher.on("error", (event) => {
      console.warn(`watcher error (session ${event.sessionId}):`, event.error);
    });
    tracker.on("change", (event) => {
      this.#broadcast(
        { type: "status", sessionId: event.sessionId, status: event.status },
        (subs) => subs.has(event.sessionId) || subs.has("*"),
      );
    });
  }

  #broadcastToSubscribers(sessionId: string, frame: unknown): void {
    this.#broadcast(frame, (subs) => subs.has(sessionId));
  }

  #broadcastAll(frame: unknown): void {
    this.#broadcast(frame, () => true);
  }

  #broadcast(frame: unknown, match: (subs: Set<string>) => boolean): void {
    const payload = JSON.stringify(frame);
    for (const [ws, state] of this.#clients) {
      if (ws.readyState !== WebSocket.OPEN || !match(state.subs)) continue;
      ws.send(payload);
    }
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
