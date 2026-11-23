import type {
  CommandDescriptor, CompactMetadata, ContextUsage, RateLimitInfo, ResultUsage, WorkerEvent,
} from "@claude-remote/agent-bridge";

export interface CommandCatalog {
  source: "sdk_init" | "sdk_discovery" | "sdk_update";
  commands: Array<CommandDescriptor & {
    kind: "skill" | "command" | "unknown";
    availability: "available" | "unverified";
  }>;
}

type CommandInit = Extract<WorkerEvent, { type: "command_init" }>;

// The control discovery list can include terminal commands. These built-ins
// support headless execution. Other entries need CLI or skill confirmation.
const HEADLESS = new Set(["compact", "context", "usage"]);
const SESSION_RESET_COMMANDS = new Set(["clear", "reset", "new"]);
const OBSERVED_TERMINAL = new Set(["doctor", "color", "focus", "reload-plugins", "theme", "terminal-setup"]);

export function commandCatalog(
  source: CommandCatalog["source"],
  descriptors: CommandDescriptor[],
  init?: CommandInit,
  loadedSkills?: string[],
): CommandCatalog {
  const skills = new Set(loadedSkills ?? init?.skills);
  const declared = new Set(init?.commands);
  const blocked = new Set([...OBSERVED_TERMINAL, ...SESSION_RESET_COMMANDS, ...(init?.terminalCommands ?? [])]);
  const byName = new Map<string, CommandCatalog["commands"][number]>();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== "object") continue;
    const { name, description, argumentHint, aliases } = descriptor;
    if (typeof name !== "string" || !name || blocked.has(name)) continue;
    const isSkill = skills.has(name);
    const isCommand = HEADLESS.has(name) || (init?.skills !== undefined && declared.has(name));
    const kind = isSkill ? "skill" : isCommand ? "command" : "unknown";
    const confirmed = HEADLESS.has(name) || skills.has(name) || declared.has(name);
    byName.set(name, {
      name, kind, availability: confirmed ? "available" : "unverified",
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof argumentHint === "string" ? { argumentHint } : {}),
      ...(Array.isArray(aliases) ? { aliases: aliases.filter((alias) => typeof alias === "string" && !blocked.has(alias)) } : {}),
    });
  }
  if (source === "sdk_init") {
    for (const name of declared) {
      if (!blocked.has(name) && !byName.has(name)) byName.set(name, {
        name, kind: skills.has(name) ? "skill" : init?.skills ? "command" : "unknown", availability: "available",
      });
    }
  }
  return { source, commands: [...byName.values()] };
}

export type ContextReport =
  | { status: "available"; source: "sdk"; context: ContextUsage }
  | { status: "unavailable"; reason: "terminal_driving" | "sdk_unavailable" | "session_changed" | "no_active_sdk" };

export function contextReport(value: ContextUsage): ContextReport {
  if (!Number.isFinite(value.totalTokens) || !Number.isFinite(value.maxTokens) ||
    !Number.isFinite(value.percentage) || !Array.isArray(value.categories)) {
    return { status: "unavailable", reason: "sdk_unavailable" };
  }
  return { status: "available", source: "sdk", context: value };
}

export interface SteerReceipt {
  runId: string;
  clientMessageId: string;
  text: string;
  state: "queued" | "delivered" | "processed" | "cancelled" | "failed";
  revision: number;
  error?: string;
}

export interface CompactReceipt {
  runId: string;
  clientMessageId: string;
  state: "compacting" | "success" | "failed" | "not_needed" | "cancelled";
  error?: string;
  boundary?: { eventId: string; metadata: CompactMetadata };
}

export interface TurnUsage {
  runId: string;
  resultId: string;
  turnIndex: number;
  clientMessageId?: string;
  isError: boolean;
  usage?: ResultUsage["usage"];
  turnModelUsage?: Record<string, unknown>;
  sdkTotals?: Pick<ResultUsage, "modelUsage" | "total_cost_usd"> & {
    scope: "session" | "query" | "unknown";
    source: "sdk_estimate";
  };
}

export type Quota = RateLimitInfo & { runId: string; eventId: string; observedAt: number };

export const NO_COMPACTION_NEEDED = /^(?:error:\s*)?(?:no messages|not enough messages|nothing) to compact[.!]?$/i;

export function usageScope(version: string | undefined): NonNullable<TurnUsage["sdkTotals"]>["scope"] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return "unknown";
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 277))) ? "session" : "query";
}

export interface SideChatReply {
  answer: string;
  model?: string;
  usage?: ResultUsage["usage"];
}

export type McpOverview =
  | { status: "available"; servers: Array<{ name: string; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" }> }
  | { status: "unavailable" };
