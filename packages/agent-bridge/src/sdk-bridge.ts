import { query, type CanUseTool, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ContextUsage } from "./types.js";

export type QueryFactory = typeof query;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export type ExternalPermissionMode = Exclude<PermissionMode, "dontAsk">;

export function configuredClaudeExecutable(): string | undefined {
  return process.env.CLAUDE_BIN?.trim() || undefined;
}
export interface StartQueryOptions {
  cwd: string;
  prompt?: string;
  /** Metadata probes keep stdin open and send no user message. */
  persistSession?: boolean;
  readOnlySideChat?: boolean;
  clientMessageId?: string;
  canUseTool: CanUseTool;
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

export interface SdkQueryHandle {
  readonly messages: AsyncIterable<SDKMessage>;
  steer(prompt: string, clientMessageId?: string): Promise<void>;
  supportedCommands(): ReturnType<Query["supportedCommands"]>;
  reloadSkills(): ReturnType<Query["reloadSkills"]>;
  getContextUsage(): Promise<ContextUsage>;
  mcpServerStatus(): ReturnType<Query["mcpServerStatus"]>;
  closeAndWait(): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

export function startSdkQuery(options: StartQueryOptions, queryFactory: QueryFactory = query): SdkQueryHandle {
  if (options.resume !== undefined && options.sessionId !== undefined) {
    throw new TypeError("resume and sessionId are mutually exclusive");
  }
  const input = new InputStream();
  if (options.prompt !== undefined) input.push(userMessage(options.prompt, options.clientMessageId));
  const sdkOptions = {
    cwd: options.cwd,
    canUseTool: options.canUseTool,
    permissionMode: options.readOnlySideChat ? "dontAsk" as const : options.permissionMode ?? "default",
    includePartialMessages: true,
    persistSession: options.readOnlySideChat ? false : options.persistSession ?? true,
    ...(options.readOnlySideChat ? {
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
  const abort = (): void => {
    input.close(true);
    void sdkQuery.interrupt().catch(() => undefined);
  };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  const closeInput = (): void => {
    input.close();
    options.signal.removeEventListener("abort", abort);
  };
  return {
    messages: sdkQuery,
    async steer(prompt: string, clientMessageId?: string): Promise<void> {
      if (options.signal.aborted) throw new Error("query input is aborted");
      input.push(userMessage(prompt, clientMessageId));
    },
    supportedCommands: () => sdkQuery.supportedCommands(),
    reloadSkills: () => sdkQuery.reloadSkills(),
    async getContextUsage(): Promise<ContextUsage> {
      const { gridRows: _gridRows, ...usage } = await sdkQuery.getContextUsage();
      return usage;
    },
    mcpServerStatus: () => sdkQuery.mcpServerStatus(),
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

function userMessage(prompt: string, uuid?: string): SDKUserMessage {
  return {
    type: "user",
    ...(uuid === undefined ? {} : { uuid: uuid as NonNullable<SDKUserMessage["uuid"]> }),
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}
