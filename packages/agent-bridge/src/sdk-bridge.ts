import { query, type CanUseTool, type OnElicitation, type PermissionMode, type Query, type RewindFilesResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ContextUsage, NativeMediaInput } from "./types.js";

export type QueryFactory = typeof query;

export class SessionToggleUnsupportedError extends Error {}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export type ExternalPermissionMode = Exclude<PermissionMode, "dontAsk">;

export function configuredClaudeExecutable(): string | undefined {
  return process.env.CLAUDE_BIN?.trim() || undefined;
}
export interface StartQueryOptions {
  cwd: string;
  prompt?: string;
  attachments?: readonly NativeMediaInput[];
  /** Metadata probes keep stdin open and send no user message. */
  persistSession?: boolean;
  readOnlySideChat?: boolean;
  rewindControl?: boolean;
  clientMessageId?: string;
  canUseTool: CanUseTool;
  onElicitation?: OnElicitation;
  resume?: string;
  /** Explicit model override for this turn. Omit to use the CLI/settings default. */
  model?: string;
  effort?: EffortLevel;
  /** Explicit session id for a new session. Mutually exclusive with resume. */
  sessionId?: string;
  /** 权限模式覆盖；省略时由 SDK 走 "default"。 */
  permissionMode?: ExternalPermissionMode;
  signal: AbortSignal;
}

class InputStream implements AsyncIterable<SDKUserMessage> {
  readonly #pending: SDKUserMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("query input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#pending.push(message);
  }

  close(discardPending = false): void {
    this.#closed = true;
    if (discardPending) this.#pending.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.#pending.shift();
        if (value) return { done: false as const, value };
        if (this.#closed) return { done: true as const, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class SdkTaskStopError extends Error {
  constructor(readonly code: "task_inactive" | "task_stop_unavailable") { super(code); }
}

export interface SdkQueryHandle {
  readonly messages: AsyncIterable<SDKMessage>;
  steer(prompt: string, clientMessageId?: string): Promise<void>;
  supportedCommands(): ReturnType<Query["supportedCommands"]>;
  reloadSkills(): ReturnType<Query["reloadSkills"]>;
  getContextUsage(): Promise<ContextUsage>;
  mcpServerStatus(): ReturnType<Query["mcpServerStatus"]>;
  stopTask(taskId: string): Promise<void>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): ReturnType<Query["toggleMcpServer"]>;
  reloadPlugins(): ReturnType<Query["reloadPlugins"]>;
  closeAndWait(): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

export function startSdkQuery(options: StartQueryOptions, queryFactory: QueryFactory = query): SdkQueryHandle {
  if (options.resume !== undefined && options.sessionId !== undefined) {
    throw new TypeError("resume and sessionId are mutually exclusive");
  }
  if (options.rewindControl && (options.prompt !== undefined || options.attachments?.length || options.resume === undefined)) {
    throw new TypeError("rewind control requires resume and does not accept a prompt");
  }
  const { signal } = options;
  const input = new InputStream();
  if (options.prompt !== undefined || options.attachments?.length) {
    input.push(userMessage(options.prompt ?? "", options.clientMessageId, options.attachments));
  }
  const restricted = options.readOnlySideChat || options.rewindControl;
  const persistSession = restricted ? false : options.persistSession ?? true;
  const sdkOptions = {
    cwd: options.cwd,
    canUseTool: options.canUseTool,
    onElicitation: (restricted ? undefined : options.onElicitation) ?? (async () => ({ action: "cancel" as const })),
    permissionMode: restricted ? "dontAsk" as const : options.permissionMode ?? "default",
    ...(!restricted && options.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    persistSession,
    enableFileCheckpointing: persistSession || options.rewindControl === true,
    ...(restricted ? {
      settingSources: [], tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
      settings: { disableAllHooks: true }, maxTurns: 1,
    } : {}),
    extraArgs: { "replay-user-messages": null },
    // SDK options.env replaces the subprocess env entirely, so we must spread
    // process.env ourselves. Overriding CLAUDE_CODE_ENTRYPOINT to "claude-remote"
    // keeps the session visible in the Mac terminal's /resume list (CLI hides
    // sessions whose entrypoint ∈ {sdk-cli, sdk-ts, sdk-py}).
    env: { ...withoutHostAuth(process.env), CLAUDE_CODE_ENTRYPOINT: "claude-remote" } as Record<string, string>,
    // CLAUDE_BIN：GUI 壳 app 的子进程没有 shell PATH，由壳注入显式 claude 路径（docs/mac-app-plan.md §2.2）
    ...(configuredClaudeExecutable() ? { pathToClaudeCodeExecutable: configuredClaudeExecutable()! } : {}),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  };
  const sdkQuery: Query = queryFactory({ prompt: input, options: sdkOptions });
  let closed = false;
  const abort = (): void => {
    input.close(true);
    void sdkQuery.interrupt().catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const closeInput = (): void => {
    closed = true;
    input.close();
    signal.removeEventListener("abort", abort);
  };
  return {
    messages: sdkQuery,
    async steer(prompt: string, clientMessageId?: string): Promise<void> {
      if (options.rewindControl) throw new Error("rewind control does not accept user messages");
      if (signal.aborted) throw new Error("query input is aborted");
      input.push(userMessage(prompt, clientMessageId));
    },
    supportedCommands: () => sdkQuery.supportedCommands(),
    reloadSkills: () => sdkQuery.reloadSkills(),
    async getContextUsage(): Promise<ContextUsage> {
      const { gridRows: _gridRows, ...usage } = await sdkQuery.getContextUsage();
      return usage;
    },
    mcpServerStatus: () => sdkQuery.mcpServerStatus(),
    async stopTask(taskId: string): Promise<void> {
      if (closed || options.signal.aborted || typeof sdkQuery.stopTask !== "function") {
        throw new SdkTaskStopError("task_stop_unavailable");
      }
      try {
        await sdkQuery.stopTask(taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const missing = `No task found with ID: ${taskId}`;
        const notRunning = `Task ${taskId} is not running`;
        if (message === missing || message.startsWith(`${missing}. `) || message === `Task not found: ${taskId}` ||
          message === notRunning || message.startsWith(`${notRunning} (status: `)) {
          throw new SdkTaskStopError("task_inactive");
        }
        throw new SdkTaskStopError("task_stop_unavailable");
      }
    },
    rewindFiles: (userMessageId, rewindOptions) => sdkQuery.rewindFiles(userMessageId, rewindOptions),
    reconnectMcpServer: async (name) => sdkQuery.reconnectMcpServer(name),
    async toggleMcpServer(): Promise<void> {
      // The bundled CLI persists this control in the project's .claude.json entry.
      throw new SessionToggleUnsupportedError("SDK does not support session-only MCP toggle");
    },
    reloadPlugins: async () => sdkQuery.reloadPlugins(),
    async interrupt(): Promise<void> { await sdkQuery.interrupt(); },
    close(): void {
      closeInput();
      sdkQuery.close();
    },
    async closeAndWait(): Promise<void> {
      closeInput();
      // The SDK's Query.return() waits for transport cleanup and child exit.
      if (typeof sdkQuery.return === "function") await sdkQuery.return();
      else sdkQuery.close();
    },
  };
}

// daemon 若从 Claude 桌面端会话里启动，会继承这些"凭据由宿主托管"的标记；
// claude 子进程看到它们就会忽略 ~/.claude/settings.json 里的凭据，等宿主下发，而 daemon 不提供 → "Not logged in"。
const HOST_AUTH_ENV = ["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH"];

function withoutHostAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of HOST_AUTH_ENV) delete copy[key];
  return copy;
}

function userMessage(prompt: string, uuid?: string, attachments?: readonly NativeMediaInput[]): SDKUserMessage {
  let content: SDKUserMessage["message"]["content"] = prompt;
  if (attachments?.length) {
    content = prompt.trim() === "" ? [] : [{ type: "text", text: prompt }];
    for (const item of attachments) {
      if (item.mediaType === "application/pdf") {
        content.push({ type: "document", title: item.title, source: { type: "base64", media_type: item.mediaType, data: item.data } });
      } else {
        content.push({ type: "image", source: { type: "base64", media_type: item.mediaType, data: item.data } });
      }
    }
  }
  return {
    type: "user",
    ...(uuid === undefined ? {} : { uuid: uuid as NonNullable<SDKUserMessage["uuid"]> }),
    message: { role: "user", content },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}
