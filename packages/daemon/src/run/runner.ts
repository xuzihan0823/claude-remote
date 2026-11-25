// SDK resume 轮次驱动。
//
// startTurn 的前置检查与活跃 run 注册全部同步完成（同一 tick 内的并发 startTurn
// 不存在竞态窗口），SDK 消息流由本模块自建的 #consume 异步消费。
//
// completion 由构造方自己消费并保证 settle（旧项目审查教训）：正常结束、流中抛错、
// abort 三条路径一律先落 `run` 终态事件、关闭事件队列，再 resolve——永不 reject，
// 因此即使调用方不 await completion 也不会产生 unhandledRejection。

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { safePlugins, safeServers, type ExtensionAction, type ExtensionResult, type Plugin } from "./extensions.js";

import {
  adaptSdkMessage,
  createElicitationAdapter,
  createPermissionAdapter,
  startSdkQuery,
  SdkTaskStopError,
  SessionToggleUnsupportedError,
  type ElicitationBroker,
  type PermissionBroker,
  type QueryFactory,
  type RewindFilesResult,
  type SdkQueryHandle,
  type EffortLevel,
  type ExternalPermissionMode,
  type NativeMediaInput,
  type WorkerEvent,
  type CommandDescriptor,
  type StartQueryOptions,
} from "@claude-remote/agent-bridge";
import {
  commandCatalog, contextReport, NO_COMPACTION_NEEDED, usageScope,
  type CommandCatalog, type CompactReceipt, type ContextReport, type McpOverview, type Quota, type SideChatReply, type SteerReceipt, type TurnUsage,
} from "./p1.js";
import { RunTasks, type TaskSnapshot } from "./tasks.js";

/**
 * 驾驶互斥门。03 卡的 ActivityTracker 实现此接口（beginRun → daemon-driving，
 * endRun → 重新评估）；本卡只依赖接口定义，测试用 stub。
 */
export interface ActivityGate {
  isIdle(sessionId: string): boolean;
  beginRun(sessionId: string): void;
  endRun(sessionId: string): void;
}

/** 会话非 idle（或已有活跃 run）时 startTurn 抛出；06 卡映射 HTTP 409。 */
export class NotIdleError extends Error {}

export class RunRequestError extends Error {
  constructor(
    readonly code: "run_mismatch" | "not_idle" | "run_stopping" | "queue_full" | "message_id_conflict" |
      "steer_not_found" | "steer_not_editable" | "steer_not_cancellable" | "steer_not_sendable" |
      "no_active_run" | "task_not_found" | "task_stop_unavailable",
    readonly state?: SteerReceipt["state"],
  ) {
    super(code);
  }
}

/** 事件流元素：`run` 为轮次生命周期（对应 WS run 帧），`worker` 为 SDK 消息展平。 */
export type RunEvent =
  | { type: "run"; runId: string; sessionId: string; state: "started" | "done" | "error"; error?: string; permissionMode?: string }
  | { type: "stream_reset"; sessionId: string; runId: string }
  | { type: "steer"; sessionId: string; runId: string; receipt: SteerReceipt }
  | { type: "compaction"; sessionId: string; runId: string; receipt: CompactReceipt }
  | { type: "task"; sessionId: string; runId: string; task: TaskSnapshot }
  | { type: "commands"; sessionId: string; runId: string; catalog: CommandCatalog }
  | { type: "usage"; sessionId: string; runId: string; turn: TurnUsage }
  | { type: "quota"; sessionId: string; runId: string; quota: Quota }
  | { type: "worker"; runId: string; sessionId: string; event: WorkerEvent };

export type RunOutcome = { state: "done" } | { state: "error"; error: string };

export interface StartTurnOptions {
  sessionId: string;
  cwd: string;
  text: string;
  attachments?: readonly NativeMediaInput[];
  clientMessageId?: string;
  /** Per-turn override. Omit to follow the Mac-side CLI/settings default. */
  model?: string;
  effort?: EffortLevel;
  /** Start a new persisted SDK session with sessionId instead of resuming it. */
  newSession?: boolean;
  compact?: { clientMessageId: string };
  /** 权限模式覆盖；省略时由 SDK 走 "default"。 */
  permissionMode?: ExternalPermissionMode;
}

export interface TurnHandle {
  runId: string;
  /** 单消费者事件流：started → worker* → done|error 后结束。 */
  events: AsyncIterable<RunEvent>;
  /** 永不 reject；不 await 也安全。 */
  completion: Promise<RunOutcome>;
}

interface RewindOptions {
  sessionId: string;
  file: string;
  cwd: string;
  userMessageId: string;
  dryRun: boolean;
  isCliAlive: () => Promise<boolean>;
  signal: AbortSignal;
}

type RewindOutcome =
  | { result: RewindFilesResult; error?: never }
  | { result?: never; error: "terminal_driving" | "sdk_unavailable" | "rewind_failed" | "rewind_outcome_unknown" };

export interface TurnRunnerOptions {
  gate: ActivityGate;
  permissions: PermissionBroker;
  elicitation?: ElicitationBroker;
  /** interactions 侧的固定用户标识（本项目单用户），默认 "web"。 */
  userId?: string;
  /**
   * abort 后等待 SDK interrupt 生效的上限，默认 5_000。超时仍未收尾（CLI 卡在 API 重试、
   * 子进程无响应等）则强制 sdk.close() 并结束本轮，保证「停止」一定能让会话回到 idle。
   */
  abortGraceMs?: number;
  /** 透传 createPermissionAdapter 的审批超时（PERMISSION_TIMEOUT_MS）。 */
  permissionTimeoutMs?: number;
  /** 测试注入 fake；缺省用真实 Agent SDK。 */
  queryFactory?: QueryFactory;
}

/** 缓冲式异步事件队列：push 先于消费不丢事件；close 后迭代自然结束。 */
class EventQueue<T extends object> implements AsyncIterable<T> {
  readonly #pending: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#pending.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#pending.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface PendingSteer {
  receipt: SteerReceipt;
}

type LiveReplayEvent = Extract<WorkerEvent, { type: "command_output" | "compact_boundary" }>;

interface RunQuery {
  plugins?: Plugin[] | null;
  extensionBusy?: boolean;
  sdk: SdkQueryHandle;
  approvals: AbortController;
  interruptBoundary: AbortController;
}

interface ActiveRun {
  runId: string;
  cwd: string;
  query: RunQuery;
  tasks: RunTasks;
  taskStops: Map<string, Promise<TaskSnapshot>>;
  options: StartTurnOptions;
  interrupting?: { clientMessageId: string; timer: ReturnType<typeof setTimeout> };
  mcpRequest?: Promise<McpOverview>;
  queue: EventQueue<RunEvent>;
  pending: PendingSteer[];
  steering?: PendingSteer;
  initialInputId: string | undefined;
  currentInputId: string | undefined;
  contextRequest?: Promise<ContextReport>;
  commandInit?: Extract<WorkerEvent, { type: "command_init" }>;
  catalog?: CommandCatalog;
  compaction?: CompactReceipt;
  compactFailure?: string;
  compactSuccess?: boolean;
  replays: LiveReplayEvent[];
  sessionId: string;
  requestedPermissionMode: ExternalPermissionMode;
  effectivePermissionMode?: string;
  diagnostics: Array<Extract<WorkerEvent, { type: "permission_denied" | "notice" }>>;
  controller: AbortController;
  aborted: boolean;
  /** abort 宽限期满后调用：强制结束 #consume 的消息循环。 */
  forceStop: () => void;
  forceTimer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_ABORT_GRACE_MS = 5_000;
const FORCE_STOPPED = Symbol("force-stopped");
const INTERRUPT_BOUNDARY = Symbol("interrupt-boundary");
const SIDE_CHAT_TIMEOUT_MS = 60_000;
const MAX_SIDE_CHATS = 4;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_RECEIPTS = 4096;
const MAX_RECENT_TASKS = 1024;
const MAX_PENDING = 16;
const MAX_PROBES = 4;
const CONTROL_TIMEOUT_MS = 5_000;
const REWIND_TIMEOUT_MS = 30_000;

interface RecentReceipt<T> {
  receipt: T;
  expiresAt: number;
}

function control<T>(operation: (() => Promise<T>) | Promise<T>, signal: AbortSignal, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let stop: () => void;
  const deadline = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("SDK control request stopped"));
    timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
  const request = typeof operation !== "function" ? operation : Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation();
  });
  return Promise.race([request, deadline]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  });
}

export class TurnRunner {
  readonly #gate: ActivityGate;
  readonly #permissions: PermissionBroker;
  readonly #elicitation: ElicitationBroker | undefined;
  readonly #userId: string;
  readonly #permissionTimeoutMs: number | undefined;
  readonly #abortGraceMs: number;
  readonly #queryFactory: QueryFactory | undefined;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #sessionRuns = new Map<string, string>();
  readonly #steers = new Map<string, RecentReceipt<SteerReceipt>>();
  readonly #compactions = new Map<string, RecentReceipt<CompactReceipt>>();
  readonly #recentTasks = new Map<string, RecentReceipt<TaskSnapshot>>();
  readonly #usage = new Map<string, TurnUsage>();
  readonly #quotas = new Map<string, Map<string, Quota>>();
  readonly #probes = new Map<string, AbortController>();
  readonly #sideChats = new Map<string, AbortController>();
  readonly #rewinds = new Map<string, AbortController>();
  #metadataClosing = false;

  constructor(options: TurnRunnerOptions) {
    this.#gate = options.gate;
    this.#permissions = options.permissions;
    this.#elicitation = options.elicitation;
    this.#userId = options.userId ?? "web";
    this.#permissionTimeoutMs = options.permissionTimeoutMs;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.#queryFactory = options.queryFactory;
  }

  startTurn(options: StartTurnOptions): TurnHandle {
    const { attachments, ...runOptions } = options;
    const { sessionId, cwd, text, newSession = false, permissionMode } = runOptions;
    if (typeof text !== "string" || (text.trim() === "" && !attachments?.length)) {
      throw new TypeError("a turn requires text or attachments");
    }
    if (newSession && !isUuid(sessionId)) {
      throw new TypeError("new sessionId must be a UUID");
    }
    const key = sessionRunKey(sessionId);
    if (this.#sessionRuns.has(key) || this.#rewinds.has(key)) {
      throw new NotIdleError(`session ${sessionId} already has an active daemon run`);
    }
    if (!this.#gate.isIdle(sessionId)) {
      throw new NotIdleError(`session ${sessionId} is not idle`);
    }

    if (options.compact) {
      this.#pruneReceipts(this.#compactions);
      if (this.#compactions.size >= MAX_RECEIPTS) throw new RunRequestError("queue_full");
    }
    const runId = randomUUID();
    const currentInputId = options.compact?.clientMessageId ?? options.clientMessageId;
    this.#gate.beginRun(sessionId);
    const controller = new AbortController();
    let query: RunQuery;
    try {
      query = this.#openRunQuery(options, runId, controller.signal, options.compact ? undefined : text, currentInputId, newSession);
    } catch (error) {
      controller.abort();
      this.#safeEndRun(sessionId);
      throw error;
    }

    let forceStop!: () => void;
    const forceStopped = new Promise<typeof FORCE_STOPPED>((resolve) => {
      forceStop = () => resolve(FORCE_STOPPED);
    });
    const queue = new EventQueue<RunEvent>();
    const run: ActiveRun = { sessionId, runId, cwd, query, options: runOptions, queue, initialInputId: currentInputId, currentInputId, pending: [], replays: [],
      controller, aborted: false, forceStop, forceTimer: undefined,
      requestedPermissionMode: permissionMode ?? "default", diagnostics: [], taskStops: new Map(),
      tasks: new RunTasks(runId, (task) => queue.push({ type: "task", sessionId, runId, task })) };
    this.#runs.set(runId, run);
    this.#quotas.delete(sessionId);
    this.#sessionRuns.set(key, runId);

    queue.push({ type: "run", runId, sessionId, state: "started", ...(permissionMode === undefined ? {} : { permissionMode }) });
    if (options.compact) {
      this.#setCompaction(run, { runId, clientMessageId: options.compact.clientMessageId, state: "compacting" });
    }
    const completion = this.#consume(run, forceStopped, options.compact ? text : undefined);
    return { runId, events: queue, completion };
  }

  #openRunQuery(
    options: StartTurnOptions, runId: string, signal: AbortSignal, prompt: string | undefined, clientMessageId: string | undefined, newSession = false,
  ): RunQuery {
    const { sessionId, cwd, model, effort, permissionMode, attachments } = options;
    const approvals = new AbortController();
    const context = { sessionKey: sessionId, runId, userId: this.#userId };
    const adapterOptions = {
      signal: AbortSignal.any([signal, approvals.signal]),
      ...(this.#permissionTimeoutMs === undefined ? {} : { timeoutMs: this.#permissionTimeoutMs }),
    };
    const canUseTool = createPermissionAdapter(this.#permissions, context, adapterOptions);
    const launch: StartQueryOptions = {
      cwd, canUseTool, signal,
      ...(this.#elicitation === undefined ? {} : { onElicitation: createElicitationAdapter(this.#elicitation, context, adapterOptions) }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
      ...(newSession ? { sessionId } : { resume: sessionId }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
    return { sdk: startSdkQuery(launch, this.#queryFactory), approvals, interruptBoundary: new AbortController() };
  }

  /** 中断指定 run（经 AbortSignal → SDK interrupt）。未知 runId 返回 false。 */
  abort(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined) return false;
    if (run.aborted) return true; // 重复点停止：已在收尾中
    run.aborted = true;
    this.#settleSteers(run, "cancelled", "aborted");
    run.controller.abort(new Error("aborted"));
    run.forceTimer = setTimeout(() => {
      console.warn(`run ${runId} did not settle ${this.#abortGraceMs}ms after abort; force-closing SDK`);
      run.forceStop();
    }, this.#abortGraceMs);
    return true;
  }

  tasks(sessionId: string): TaskSnapshot[] {
    this.#pruneReceipts(this.#recentTasks);
    const prefix = `${sessionId}:`;
    const recent = [...this.#recentTasks].filter(([key]) => key.startsWith(prefix)).map(([, { receipt }]) => receipt);
    return [...this.#findRun(sessionId)?.tasks.values() ?? [], ...recent.reverse()];
  }

  async stopTask(sessionId: string, taskId: string, runId?: string): Promise<TaskSnapshot> {
    const run = this.#findRun(sessionId);
    if (!run) {
      const recent = this.tasks(sessionId).find((task) => task.taskId === taskId && (runId === undefined || task.runId === runId));
      if (recent) return recent;
      throw new RunRequestError("no_active_run");
    }
    if (runId !== undefined && runId !== run.runId) throw new RunRequestError("run_mismatch");
    const task = run.tasks.get(taskId);
    if (!task) throw new RunRequestError("task_not_found");
    if (task.status !== "running" || task.stopRequested) return task;
    const pending = run.taskStops.get(taskId);
    if (pending) return pending;
    if (run.aborted || run.interrupting) throw new RunRequestError("run_stopping");
    const request = this.#requestTaskStop(run, task).finally(() => run.taskStops.delete(taskId));
    run.taskStops.set(taskId, request);
    return request;
  }

  async #requestTaskStop(run: ActiveRun, original: TaskSnapshot): Promise<TaskSnapshot> {
    const { taskId } = original;
    const query = run.query;
    const signal = AbortSignal.any([run.controller.signal, query.approvals.signal]);
    const failure = await control(async () => {
      if (run.tasks.get(taskId)?.status === "running") await query.sdk.stopTask(taskId);
    }, signal).then(() => undefined, (error: unknown) => error);
    const active = this.#findRun(run.sessionId);
    if (active && active !== run) throw new RunRequestError("run_mismatch");
    const task = run.tasks.get(taskId) ?? original;
    if (task.status !== "running") return task;
    if (run.aborted || run.interrupting || run.query !== query) throw new RunRequestError("run_stopping");
    if (failure instanceof SdkTaskStopError && failure.code === "task_inactive") return run.tasks.inactive(task);
    if (failure !== undefined) throw new RunRequestError("task_stop_unavailable");
    return run.tasks.acceptStop(task);
  }

  /** Return the active daemon run for a session, if any. */
  activeRunId(sessionId: string): string | undefined {
    return this.#sessionRuns.get(sessionRunKey(sessionId));
  }

  activeState(sessionId: string): { activeRunId: string; requestedPermissionMode: string; effectivePermissionMode?: string } | undefined {
    const activeRunId = this.activeRunId(sessionId);
    const run = activeRunId === undefined ? undefined : this.#runs.get(activeRunId);
    if (activeRunId === undefined || run === undefined) return undefined;
    return { activeRunId, requestedPermissionMode: run.requestedPermissionMode,
      ...(run.effectivePermissionMode === undefined ? {} : { effectivePermissionMode: run.effectivePermissionMode }) };
  }

  activeDiagnostics(sessionId: string): RunEvent[] {
    const runId = this.activeRunId(sessionId);
    const run = runId === undefined ? undefined : this.#runs.get(runId);
    return run === undefined || runId === undefined ? [] : run.diagnostics.map((event) => ({ type: "worker", sessionId, runId, event }));
  }

  #findRun(sessionId: string): ActiveRun | undefined {
    const runId = this.activeRunId(sessionId);
    return runId === undefined ? undefined : this.#runs.get(runId);
  }

  #pruneReceipts<T extends { runId: string }>(receipts: Map<string, RecentReceipt<T>>): void {
    const now = Date.now();
    for (const [key, entry] of receipts) if (entry.expiresAt <= now && !this.#runs.has(entry.receipt.runId)) receipts.delete(key);
  }

  steer(sessionId: string, runId: string, clientMessageId: string, text: string): { receipt: SteerReceipt; replayed: boolean } {
    this.#pruneReceipts(this.#steers);
    const previous = this.#steers.get(`${sessionId}:${clientMessageId}`)?.receipt;
    if (previous) {
      if (previous.runId !== runId) throw new RunRequestError("run_mismatch");
      return { receipt: previous, replayed: true };
    }
    const run = this.#findRun(sessionId);
    if (!run) throw new RunRequestError("not_idle");
    if (runId !== run.runId) throw new RunRequestError("run_mismatch");
    if (run.aborted) throw new RunRequestError("run_stopping");
    if (run.compaction) throw new RunRequestError("not_idle");
    if (run.initialInputId === clientMessageId) throw new RunRequestError("message_id_conflict");
    if (run.pending.length >= MAX_PENDING || this.#steers.size >= MAX_RECEIPTS) throw new RunRequestError("queue_full");
    const receipt: SteerReceipt = { runId, clientMessageId, text, state: "queued", revision: 1 };
    run.pending.push({ receipt });
    this.#setSteer(run, receipt);
    return { receipt, replayed: false };
  }

  mutateSteer(
    sessionId: string, runId: string | undefined, clientMessageId: string,
    mutation: { type: "edit"; text: string } | { type: "cancel" } | { type: "send_now" },
  ): SteerReceipt {
    const receipt = this.steerReceipt(sessionId, clientMessageId);
    if (!receipt) throw new RunRequestError("steer_not_found");
    const run = this.#findRun(sessionId);
    if ((runId !== undefined && runId !== receipt.runId) || (run && run.runId !== receipt.runId)) {
      throw new RunRequestError("run_mismatch");
    }
    const index = run?.pending.findIndex((item) => item.receipt.clientMessageId === clientMessageId) ?? -1;
    const input = run?.pending[index];
    if (!run || run.aborted || receipt.state !== "queued" || !input) {
      const code = mutation.type === "edit" ? "steer_not_editable" : mutation.type === "cancel" ? "steer_not_cancellable" : "steer_not_sendable";
      throw new RunRequestError(code, receipt.state);
    }
    if (mutation.type === "edit") {
      input.receipt = { ...input.receipt, text: mutation.text, revision: input.receipt.revision + 1 };
      this.#setSteer(run, input.receipt);
    } else if (mutation.type === "cancel") {
      run.pending.splice(index, 1);
      this.#advanceSteer(run, input, "cancelled");
    } else if (run.interrupting?.clientMessageId !== clientMessageId) {
      run.pending.splice(index, 1);
      run.pending.unshift(input);
      this.#advanceSteer(run, input, "queued");
      if (run.interrupting) {
        run.interrupting.clientMessageId = clientMessageId;
      } else {
        const query = run.query;
        const forceBoundary = (): void => query.interruptBoundary.abort();
        const timer = setTimeout(forceBoundary, this.#abortGraceMs);
        run.interrupting = { clientMessageId, timer };
        query.approvals.abort(new Error("turn interrupted"));
        void query.sdk.interrupt().catch(forceBoundary);
      }
    }
    return input.receipt;
  }

  steerReceipt(sessionId: string, clientMessageId: string): SteerReceipt | undefined {
    this.#pruneReceipts(this.#steers);
    return this.#steers.get(`${sessionId}:${clientMessageId}`)?.receipt;
  }

  compactReceipt(sessionId: string, clientMessageId: string): CompactReceipt | undefined {
    this.#pruneReceipts(this.#compactions);
    return this.#compactions.get(`${sessionId}:${clientMessageId}`)?.receipt;
  }

  #setSteer(run: ActiveRun, receipt: SteerReceipt): void {
    const expiresAt = receipt.state === "queued" || receipt.state === "delivered" ? Infinity : Date.now() + REQUEST_TTL_MS;
    this.#steers.set(`${run.sessionId}:${receipt.clientMessageId}`, { receipt, expiresAt });
    run.queue.push({ type: "steer", sessionId: run.sessionId, runId: run.runId, receipt });
  }

  #advanceSteer(run: ActiveRun, input: PendingSteer, state: SteerReceipt["state"], error?: string): void {
    input.receipt = { ...input.receipt, state, revision: input.receipt.revision + 1, ...(error === undefined ? {} : { error }) };
    this.#setSteer(run, input.receipt);
  }

  #settleSteers(run: ActiveRun, state: "failed" | "cancelled", error: string): void {
    if (run.steering) {
      this.#advanceSteer(run, run.steering, state, error);
      delete run.steering;
    }
    for (const input of run.pending.splice(0)) this.#advanceSteer(run, input, state, error);
  }

  #setCompaction(run: ActiveRun, receipt: CompactReceipt): void {
    run.compaction = receipt;
    const expiresAt = receipt.state === "compacting" ? Infinity : Date.now() + REQUEST_TTL_MS;
    this.#compactions.set(`${run.sessionId}:${receipt.clientMessageId}`, { receipt, expiresAt });
    run.queue.push({ type: "compaction", sessionId: run.sessionId, runId: run.runId, receipt });
  }

  p1State(sessionId: string) {
    this.#pruneReceipts(this.#steers);
    this.#pruneReceipts(this.#compactions);
    const run = this.#findRun(sessionId);
    const prefix = `${sessionId}:`;
    const pending = run?.pending.map(({ receipt }) => receipt) ?? [];
    const queuedIds = new Set(pending.map(({ clientMessageId }) => clientMessageId));
    const steering = [...pending, ...[...this.#steers].filter(([key, { receipt }]) =>
      key.startsWith(prefix) && !queuedIds.has(receipt.clientMessageId)).map(([, item]) => item.receipt)];
    const compactions = [...this.#compactions].filter(([key]) => key.startsWith(prefix)).map(([, item]) => item.receipt);
    const latestTurn = this.#usage.get(sessionId);
    const quotas = this.#quotas.get(sessionId);
    return {
      ...(run?.catalog === undefined ? {} : { commands: run.catalog }),
      ...(steering.length === 0 ? {} : { steering }),
      ...(compactions.length === 0 ? {} : { compactions }),
      ...(latestTurn === undefined ? {} : { latestTurn }),
      ...(quotas === undefined ? {} : { quotas: [...quotas.values()] }),
    };
  }

  activeCommandReplay(sessionId: string): RunEvent[] {
    const run = this.#findRun(sessionId);
    return run ? run.replays.map((event) => ({ type: "worker", sessionId, runId: run.runId, event })) : [];
  }

  activeCwd(sessionId: string): string | undefined {
    return this.#findRun(sessionId)?.cwd;
  }

  async commands(cwd: string, sessionId?: string): Promise<CommandCatalog | undefined> {
    const run = sessionId === undefined ? undefined : this.#findRun(sessionId);
    if (run) return run.catalog ?? undefined;
    return this.#probe("commands", cwd, sessionId, async (sdk, signal) => {
      const descriptors = await control(() => sdk.supportedCommands(), signal);
      if (!Array.isArray(descriptors)) return undefined;
      const skills = await control(() => sdk.reloadSkills(), signal).catch(() => undefined);
      // reloadSkills includes model-only skills. commandCatalog intersects these
      // with the SDK discovery list, which includes only user-invocable skills.
      const names = Array.isArray(skills?.skills)
        ? skills.skills.flatMap((item) => typeof item?.name === "string" ? [item.name] : [])
        : undefined;
      return commandCatalog("sdk_discovery", descriptors, undefined, names);
    });
  }

  async context(sessionId: string): Promise<ContextReport> {
    const run = this.#findRun(sessionId);
    if (!run) return { status: "unavailable", reason: "no_active_sdk" };
    if (run.contextRequest) return run.contextRequest;
    const query = run.query;
    const request = Promise.resolve().then(() => {
      run.controller.signal.throwIfAborted();
      return query.sdk.getContextUsage();
    });
    run.contextRequest = this.#activeContext(run, query, () => request);
    // A timed-out control may still be pending in the SDK. Share that attempt
    // until it settles, so polling cannot heap up transport requests.
    const pending = run.contextRequest;
    const clear = (): void => { if (run.contextRequest === pending) delete run.contextRequest; };
    void request.then(clear, clear);
    return run.contextRequest;
  }

  async #activeContext(run: ActiveRun, query: RunQuery, getContext: SdkQueryHandle["getContextUsage"]): Promise<ContextReport> {
    try {
      const value = await control(getContext, run.controller.signal);
      if (this.#findRun(run.sessionId) !== run || run.query !== query || run.aborted) return { status: "unavailable", reason: "session_changed" };
      return contextReport(value);
    } catch {
      return { status: "unavailable", reason: "sdk_unavailable" };
    }
  }

  extensionTargetGuard(sessionId: string): () => boolean {
    const query = this.#findRun(sessionId)?.query;
    return () => this.#findRun(sessionId)?.query === query;
  }

  async extensions(sessionId: string, action: ExtensionAction, expectedRun?: string): Promise<ExtensionResult> {
    const run = this.#findRun(sessionId);
    if (!run) return { status: "unavailable", reason: "no_active_sdk" };
    if (expectedRun !== undefined && expectedRun !== run.runId) return { status: "unavailable", reason: "run_mismatch" };
    const { query, runId } = run;
    const current = () => this.#findRun(sessionId) === run && run.query === query && !run.aborted && !run.interrupting;
    if (!current()) return { status: "unavailable", reason: "session_changed" };
    if (query.extensionBusy) return { status: "unavailable", reason: "extension_busy" };
    if (action.type === "read" && !query.plugins) {
      return { status: "unavailable", reason: query.plugins === undefined ? "initializing" : "sdk_unavailable" };
    }
    query.extensionBusy = true;
    let expired = false;
    const check = () => { if (expired || !current()) throw new Error("session_changed"); };
    const request = Promise.resolve().then(async (): Promise<ExtensionResult> => {
      check();
      if (action.type === "reload") {
        // A failed or timed-out reload can still have changed the subprocess.
        query.plugins = null;
        const snapshot = await query.sdk.reloadPlugins();
        check();
        const mcp = safeServers(snapshot.mcpServers);
        const plugins = safePlugins(snapshot.plugins);
        if (!Array.isArray(snapshot.commands)) throw new Error("sdk_unavailable");
        const commands = this.#updateCommands(run, snapshot.commands);
        query.plugins = plugins;
        return { status: "available", runId, mcp, plugins, commands };
      }
      if (action.type === "reconnect") {
        await query.sdk.reconnectMcpServer(action.name);
        check();
      } else if (action.type === "toggle") {
        await query.sdk.toggleMcpServer(action.name, action.enabled);
        check();
      }
      const mcp = safeServers(await query.sdk.mcpServerStatus());
      check();
      if (action.type === "reconnect" || action.type === "toggle") {
        const server = mcp.find((item) => item.name === action.name);
        return server ? { status: "available", runId, server } : { status: "unavailable", reason: "server_not_found" };
      }
      if (!query.plugins) return { status: "unavailable", reason: "initializing" };
      return { status: "available", runId, mcp, plugins: query.plugins };
    }).finally(() => { delete query.extensionBusy; });
    try {
      const result = await control(request, run.controller.signal);
      return current() ? result : { status: "unavailable", reason: "session_changed" };
    } catch (error) {
      if (!current()) return { status: "unavailable", reason: "session_changed" };
      return { status: "unavailable", reason: error instanceof SessionToggleUnsupportedError ? "session_toggle_unsupported" : "sdk_unavailable" };
    } finally {
      expired = true;
    }
  }

  #updateCommands(run: ActiveRun, descriptors: CommandDescriptor[]): CommandCatalog {
    const catalog = commandCatalog("sdk_update", descriptors, run.commandInit);
    if (run.catalog && isDeepStrictEqual(run.catalog.commands, catalog.commands)) return run.catalog;
    run.catalog = catalog;
    run.queue.push({ type: "commands", sessionId: run.sessionId, runId: run.runId, catalog });
    return catalog;
  }

  async mcpOverview(sessionId: string): Promise<McpOverview> {
    const run = this.#findRun(sessionId);
    if (!run || run.aborted || run.interrupting) return { status: "unavailable" };
    if (run.mcpRequest) return run.mcpRequest;
    const query = run.query;
    const request = Promise.resolve().then(() => query.sdk.mcpServerStatus());
    const pending = control(() => request, run.controller.signal).then((servers): McpOverview => {
      if (this.#findRun(sessionId) !== run || run.query !== query || run.aborted || run.interrupting || !Array.isArray(servers)) {
        return { status: "unavailable" };
      }
      return { status: "available", servers: servers.flatMap((server) =>
        typeof server?.name === "string" && ["connected", "failed", "needs-auth", "pending", "disabled"].includes(server.status)
          ? [{ name: server.name, status: server.status }] : []) };
    }).catch((): McpOverview => ({ status: "unavailable" }));
    run.mcpRequest = pending;
    const clear = (): void => { if (run.mcpRequest === pending) delete run.mcpRequest; };
    void request.then(clear, clear);
    return pending;
  }

  async sideChat(cwd: string, sessionId: string, question: string, clientMessageId: string | undefined, clientSignal: AbortSignal): Promise<SideChatReply | undefined> {
    if (this.#metadataClosing || clientSignal.aborted || this.#sideChats.size >= MAX_SIDE_CHATS || this.#sideChats.has(sessionId)) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, clientSignal]);
    this.#sideChats.set(sessionId, controller);
    let sdk: SdkQueryHandle | undefined;
    try {
      const side = startSdkQuery({
        cwd, resume: sessionId, persistSession: false, signal, readOnlySideChat: true,
        prompt: `Answer this side question using the resumed conversation. Do not use tools.\n\n${question}`,
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
        canUseTool: async () => ({ behavior: "deny", message: "Read-only /btw side chat" }),
      }, this.#queryFactory);
      sdk = side;
      return await control(async () => {
        let model: string | undefined;
        let answer: string | undefined;
        for await (const message of side.messages) {
          if ("session_id" in message && message.session_id !== sessionId) continue;
          if (message.type === "system" && message.subtype === "init" && typeof message.model === "string") model = message.model;
          if (message.type === "assistant" && !message.parent_tool_use_id && !message.error) {
            if (typeof message.message.model === "string" && message.message.model !== "<synthetic>") model = message.message.model;
            const assistant = adaptSdkMessage(message).find((event) => event.type === "assistant");
            if (assistant?.type === "assistant") answer = assistant.text;
          }
          if (message.type !== "result") continue;
          if (message.is_error || message.subtype !== "success") return undefined;
          answer = (typeof message.result === "string" && message.result.trim() ? message.result : answer);
          if (!answer?.trim()) return undefined;
          return { answer, ...(model === undefined ? {} : { model }), ...(message.usage === undefined ? {} : { usage: message.usage }) };
        }
        return undefined;
      }, signal, SIDE_CHAT_TIMEOUT_MS);
    } catch {
      return undefined;
    } finally {
      if (sdk) {
        const side = sdk;
        try {
          await control(() => side.closeAndWait(), new AbortController().signal);
        } catch {
          try { side.close(); } catch { /* SDK may already be closed. */ }
        }
      }
      this.#sideChats.delete(sessionId);
    }
  }

  async rewindFiles(options: RewindOptions): Promise<RewindOutcome> {
    const { sessionId, file, cwd, userMessageId, dryRun } = options;
    const key = sessionRunKey(sessionId);
    if (this.#sessionRuns.has(key) || this.#rewinds.has(key) || !this.#gate.isIdle(sessionId)) {
      throw new NotIdleError(`session ${sessionId} is not idle`);
    }
    if (this.#metadataClosing || options.signal.aborted) return { error: "sdk_unavailable" };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.signal]);
    this.#rewinds.set(key, controller);
    this.#gate.beginRun(sessionId);
    let sdk: SdkQueryHandle | undefined;
    let dispatched = false;
    try {
      const rewind = startSdkQuery({
        cwd, resume: file, signal: controller.signal, rewindControl: true,
        canUseTool: async () => ({ behavior: "deny", message: "File rewind control does not use tools" }),
      }, this.#queryFactory);
      sdk = rewind;
      const preview = await control(() => rewind.rewindFiles(userMessageId, { dryRun: true }), signal);
      if (typeof preview.canRewind !== "boolean") return { error: "sdk_unavailable" };
      if (dryRun || !preview.canRewind) return { result: preview };
      if (await control(options.isCliAlive, signal)) return { error: "terminal_driving" };
      const result = await control(() => {
        signal.throwIfAborted();
        dispatched = true;
        return rewind.rewindFiles(userMessageId, { dryRun: false });
      }, controller.signal, REWIND_TIMEOUT_MS);
      return typeof result.canRewind === "boolean" ? { result } : { error: "rewind_outcome_unknown" };
    } catch (error) {
      if (!dispatched) return { error: "sdk_unavailable" };
      return { error: error instanceof Error && error.message.startsWith("Failed to rewind:")
        ? "rewind_failed" : "rewind_outcome_unknown" };
    } finally {
      try {
        await sdk?.closeAndWait();
      } catch {
        try { sdk?.close(); } catch { /* The SDK transport is already closing. */ }
      } finally {
        this.#rewinds.delete(key);
        this.#safeEndRun(sessionId);
      }
    }
  }

  closeMetadata(): void {
    this.#metadataClosing = true;
    for (const controller of [...this.#probes.values(), ...this.#sideChats.values(), ...this.#rewinds.values()]) controller.abort();
  }

  async #probe<T>(kind: string, cwd: string, sessionId: string | undefined, read: (sdk: SdkQueryHandle, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const key = JSON.stringify([kind, cwd, sessionId]);
    if (this.#metadataClosing || this.#probes.size >= MAX_PROBES || this.#probes.has(key)) return undefined;
    if (sessionId !== undefined && !this.#gate.isIdle(sessionId)) return undefined;
    const controller = new AbortController();
    this.#probes.set(key, controller);
    let sdk: SdkQueryHandle | undefined;
    try {
      sdk = startSdkQuery({
        cwd, persistSession: false, signal: controller.signal,
        canUseTool: async () => ({ behavior: "deny", message: "Read-only SDK control session" }),
        ...(sessionId === undefined ? {} : { resume: sessionId }),
      }, this.#queryFactory);
      return await read(sdk, controller.signal);
    } catch {
      return undefined;
    } finally {
      this.#probes.delete(key);
      try { sdk?.close(); } catch { /* Metadata lookup is already over. */ }
    }
  }

  async #consume(run: ActiveRun, forceStopped: Promise<typeof FORCE_STOPPED>, compactText?: string): Promise<RunOutcome> {
    const { sessionId, runId, queue } = run;
    let outcome: RunOutcome;
    let turnIndex = 0;
    const results = new Set<string>();
    let iterator = run.query.sdk.messages[Symbol.asyncIterator]();
    try {
      if (compactText !== undefined) {
        const sdk = run.query.sdk;
        const descriptors = await control(() => sdk.supportedCommands(), run.controller.signal);
        if (!Array.isArray(descriptors) || !descriptors.some((item) => item?.name === "compact")) throw new Error("compact_unavailable");
        await sdk.steer(compactText, run.currentInputId);
      }
      while (!run.aborted) {
        const boundary = run.query.interruptBoundary.signal;
        let finishBoundary!: () => void;
        const interrupted = new Promise<typeof INTERRUPT_BOUNDARY>((resolve) => {
          finishBoundary = () => resolve(INTERRUPT_BOUNDARY);
          if (boundary.aborted) finishBoundary();
          else boundary.addEventListener("abort", finishBoundary, { once: true });
        });
        const next = await Promise.race([iterator.next(), forceStopped, interrupted])
          .catch((error: unknown): typeof INTERRUPT_BOUNDARY => {
            if (run.interrupting) return INTERRUPT_BOUNDARY;
            throw error;
          }).finally(() => boundary.removeEventListener("abort", finishBoundary));
        if (next === FORCE_STOPPED || run.aborted) break;
        let result: Extract<WorkerEvent, { type: "result" }> | undefined;
        if (next !== INTERRUPT_BOUNDARY && !next.done) {
          if ("session_id" in next.value && next.value.session_id !== sessionId) continue;
          const message = next.value;
          if (message.type === "system" && message.subtype === "init" && Array.isArray(message.plugins) &&
            !("agent_id" in message && message.agent_id) && !("parent_tool_use_id" in message && message.parent_tool_use_id)) {
            run.query.plugins = safePlugins(message.plugins);
          }
          for (let event of adaptSdkMessage(message)) {
            if (event.type === "session" && event.sessionId !== sessionId) continue;
            if (event.type === "permission_mode") {
              run.effectivePermissionMode = event.effectiveMode;
              event = { ...event, requestedMode: run.requestedPermissionMode };
            } else if (event.type === "permission_denied" || event.type === "notice") {
              const eventId = event.eventId;
              if (run.diagnostics.some((item) => item.eventId === eventId)) continue;
              run.diagnostics.push(event);
              if (run.diagnostics.length > 100) run.diagnostics.shift();
            } else if (event.type === "result") {
              if (results.has(event.messageId) || (run.currentInputId !== undefined && event.inputIds?.length && !event.inputIds.includes(run.currentInputId))) continue;
              results.add(event.messageId);
              result = event;
              this.#recordUsage(run, event, ++turnIndex);
            } else if (event.type === "task_started" || event.type === "task_progress" || event.type === "task_notification" ||
              event.type === "background_tasks_changed" || event.type === "task_output") {
              run.tasks.record(event);
              continue;
            } else {
              if (!this.#recordP1Event(run, event)) continue;
            }
            queue.push({ type: "worker", runId, sessionId, event });
          }
          if (!result) continue;
        }
        const error = result && (result.isError || result.subtype !== "success") ? resultErrorText(result) ?? "Claude 返回错误" : undefined;
        if (run.interrupting) {
          const oldQuery = run.query;
          clearTimeout(run.interrupting.timer);
          if (run.steering) {
            const finished = result !== undefined && error === undefined;
            this.#advanceSteer(run, run.steering, finished ? "processed" : "cancelled", finished ? undefined : "interrupted");
            delete run.steering;
          }
          queue.push({ type: "stream_reset", runId, sessionId });
          await control(() => oldQuery.sdk.closeAndWait(), run.controller.signal);
          if (run.aborted) break;
          run.tasks.settle("query_interrupted");
          delete run.interrupting;
          delete run.catalog;
          delete run.commandInit;
          delete run.effectivePermissionMode;
          delete run.contextRequest;
          delete run.mcpRequest;
          const nextInput = run.pending.shift();
          if (!nextInput) throw new Error("interrupted");
          run.steering = nextInput;
          run.currentInputId = nextInput.receipt.clientMessageId;
          run.query = this.#openRunQuery(run.options, runId, run.controller.signal, nextInput.receipt.text, run.currentInputId);
          iterator = run.query.sdk.messages[Symbol.asyncIterator]();
          this.#advanceSteer(run, nextInput, "delivered");
          continue;
        }
        if (!result) throw new Error("sdk_ended_without_result");
        if (run.steering) {
          this.#advanceSteer(run, run.steering, error ? "failed" : "processed", error);
          delete run.steering;
        }
        if (run.compaction) {
          this.#finishCompaction(run, error, result.result);
          if (run.compaction.state === "failed") throw new Error(run.compaction.error ?? "compact_failed");
        }
        if (error !== undefined) throw new Error(error);
        const nextInput = run.pending.shift();
        if (!nextInput) break;
        run.steering = nextInput;
        run.currentInputId = nextInput.receipt.clientMessageId;
        const handoff = run.query.sdk.steer(nextInput.receipt.text, run.currentInputId);
        this.#advanceSteer(run, nextInput, "delivered");
        await handoff;
      }
      outcome = run.aborted ? { state: "error", error: "aborted" } : { state: "done" };
    } catch (error) {
      outcome = { state: "error", error: run.aborted ? "aborted" : error instanceof Error ? error.message : String(error) };
    } finally {
      if (run.forceTimer !== undefined) clearTimeout(run.forceTimer);
      if (run.interrupting) clearTimeout(run.interrupting.timer);
      void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
      run.query.approvals.abort();
      try { run.query.sdk.close(); } catch { /* Cleanup must not prevent settlement. */ }
    }
    if (outcome.state === "error") {
      this.#settleSteers(run, run.aborted ? "cancelled" : "failed", outcome.error);
      if (run.compaction?.state === "compacting") this.#setCompaction(run, {
        ...run.compaction, state: run.aborted ? "cancelled" : "failed", error: outcome.error,
      });
    }
    const expiry = Date.now() + REQUEST_TTL_MS;
    for (const item of this.#steers.values()) if (item.receipt.runId === runId) item.expiresAt = expiry;
    run.tasks.settle(run.aborted ? "run_aborted" : outcome.state === "error" ? "run_failed" : "run_ended");
    this.#pruneReceipts(this.#recentTasks);
    for (const receipt of run.tasks.values()) {
      this.#recentTasks.set(`${sessionId}:${runId}:${receipt.taskId}`, { receipt, expiresAt: expiry });
      const oldest = this.#recentTasks.keys().next().value;
      if (this.#recentTasks.size > MAX_RECENT_TASKS && oldest !== undefined) this.#recentTasks.delete(oldest);
    }
    this.#runs.delete(runId);
    run.controller.abort(new Error("run ended"));
    const key = sessionRunKey(sessionId);
    if (this.#sessionRuns.get(key) === runId) this.#sessionRuns.delete(key);
    this.#safeEndRun(sessionId);
    queue.push(outcome.state === "done" ? { type: "run", runId, sessionId, state: "done" }
      : { type: "run", runId, sessionId, state: "error", error: outcome.error });
    queue.close();
    return outcome;
  }

  #recordP1Event(run: ActiveRun, event: WorkerEvent): boolean {
    const { sessionId, runId, queue } = run;
    if (event.type === "command_init") {
      run.commandInit = event;
      const listed = event.commands.map((name) => ({ name }));
      run.catalog = commandCatalog("sdk_init", listed, event);
      queue.push({ type: "commands", sessionId, runId, catalog: run.catalog });
      const query = run.query;
      void control(() => query.sdk.supportedCommands(), run.controller.signal).then((descriptors) => {
        if (!Array.isArray(descriptors) || this.#runs.get(runId) !== run || run.query !== query ||
          run.aborted || run.interrupting || run.catalog?.source !== "sdk_init") return;
        const byName = new Map(descriptors.filter((item) => typeof item?.name === "string").map((item) => [item.name, item]));
        const detailed: CommandDescriptor[] = event.commands.map((name) => byName.get(name) ?? { name });
        run.catalog = commandCatalog("sdk_init", detailed, event);
        queue.push({ type: "commands", sessionId, runId, catalog: run.catalog });
      }).catch(() => undefined);
    } else if (event.type === "commands_changed") {
      this.#updateCommands(run, event.commands);
    } else if (event.type === "command_output" || event.type === "compact_boundary") {
      if (run.replays.some(({ eventId }) => eventId === event.eventId)) return false;
      run.replays.push(event);
      if (run.replays.length > 100) run.replays.shift();
      if (event.type === "compact_boundary" && run.compaction && event.metadata.trigger === "manual") {
        run.compaction = { ...run.compaction, boundary: { eventId: event.eventId, metadata: event.metadata } };
      } else if (event.type === "command_output" && run.compaction && (event.command === undefined || event.command === "compact")) {
        const output = event.output.find((part) => part.stream === "stderr" || event.failed || NO_COMPACTION_NEEDED.test(part.text.trim()));
        if (output) run.compactFailure = output.text.slice(0, 300);
      }
    } else if (event.type === "compact_status" && run.compaction) {
      if (event.state === "success") run.compactSuccess = true;
      if (event.state === "failed") run.compactFailure = event.error?.slice(0, 300) ?? "compact_failed";
    } else if (event.type === "rate_limit") {
      if (!run.commandInit || run.commandInit.subscriptionQuotas === false || !event.info.rateLimitType ||
        !["allowed", "allowed_warning", "rejected"].includes(event.info.status)) return false;
      const quota = { ...event.info, runId, eventId: event.eventId, observedAt: Date.now() };
      const quotas = this.#quotas.get(sessionId) ?? new Map<string, Quota>();
      if (quotas.get(event.info.rateLimitType)?.eventId === event.eventId) return false;
      quotas.set(event.info.rateLimitType, quota);
      this.#remember(this.#quotas, sessionId, quotas);
      queue.push({ type: "quota", sessionId, runId, quota });
    }
    return true;
  }

  #finishCompaction(run: ActiveRun, error: string | undefined, result: string | undefined): void {
    if (!run.compaction) return;
    const failure = error ?? run.compactFailure;
    const noOp = !error && NO_COMPACTION_NEEDED.test((run.compactFailure ?? result ?? "").trim());
    if (noOp) this.#setCompaction(run, { ...run.compaction, state: "not_needed" });
    else if (failure) this.#setCompaction(run, { ...run.compaction, state: "failed", error: failure });
    else if (run.compaction.boundary || run.compactSuccess) this.#setCompaction(run, { ...run.compaction, state: "success" });
    else this.#setCompaction(run, { ...run.compaction, state: "failed", error: "compact_outcome_unavailable" });
  }

  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    const oldest = map.keys().next().value;
    if (map.size > 256 && oldest !== undefined) map.delete(oldest);
  }

  #recordUsage(run: ActiveRun, event: Extract<WorkerEvent, { type: "result" }>, turnIndex: number): void {
    if (event.usage === undefined && event.modelUsage === undefined && event.total_cost_usd === undefined && event.turnModelUsage === undefined) return;
    const { runId, sessionId } = run;
    const turn: TurnUsage = {
      runId, resultId: event.messageId, turnIndex, isError: event.isError,
      ...(run.currentInputId === undefined ? {} : { clientMessageId: run.currentInputId }),
      ...(event.usage === undefined ? {} : { usage: event.usage }),
      ...(event.turnModelUsage === undefined ? {} : { turnModelUsage: event.turnModelUsage }),
      ...(event.modelUsage === undefined && event.total_cost_usd === undefined ? {} : {
        sdkTotals: {
          source: "sdk_estimate", scope: usageScope(run.commandInit?.cliVersion),
          ...(event.modelUsage === undefined ? {} : { modelUsage: event.modelUsage }),
          ...(event.total_cost_usd === undefined ? {} : { total_cost_usd: event.total_cost_usd }),
        },
      }),
    };
    this.#remember(this.#usage, sessionId, turn);
    run.queue.push({ type: "usage", runId, sessionId, turn });
  }

  #safeEndRun(sessionId: string): void {
    try {
      this.#gate.endRun(sessionId);
    } catch (error) {
      console.warn(`activityGate.endRun(${sessionId}) failed:`, error instanceof Error ? error.message : error);
    }
  }
}

function resultErrorText(event: WorkerEvent): string | undefined {
  if (event.type !== "result") return undefined;
  const record = event as unknown as { result?: unknown; errors?: unknown };
  if (typeof record.result === "string" && record.result.trim() !== "") return record.result.trim().slice(0, 300);
  if (Array.isArray(record.errors)) {
    const text = record.errors.filter((e): e is string => typeof e === "string").join("; ").trim();
    if (text !== "") return text.slice(0, 300);
  }
  return undefined;
}

function sessionRunKey(sessionId: string): string {
  return isUuid(sessionId) ? sessionId.toLowerCase() : sessionId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
