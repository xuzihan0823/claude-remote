import type {
  SDKCompactBoundaryMessage, SDKControlGetContextUsageResponse, SDKRateLimitInfo, SDKResultMessage, SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
export type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";

import type { CommandOutputPart } from "./command-output.js";

export type CommandDescriptor = Pick<SlashCommand, "name"> & Partial<Omit<SlashCommand, "name">>;
export type ContextUsage = Omit<SDKControlGetContextUsageResponse, "gridRows">;
export type CompactMetadata = SDKCompactBoundaryMessage["compact_metadata"];
export type ResultUsage = Partial<Pick<SDKResultMessage, "usage" | "modelUsage" | "total_cost_usd">>;
export type RateLimitInfo = SDKRateLimitInfo;

export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface TaskDetails {
  taskId: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  description?: string;
  toolUseId?: string;
  usage?: TaskUsage;
  lastToolName?: string;
  summary?: string;
  skipTranscript?: boolean;
}

interface TaskEventIdentity {
  eventId: string;
  observedAt: number;
  timestamp?: string;
}

export type TaskEvent = TaskEventIdentity & (
  | ({ type: "task_started" | "task_progress"; status: "running" } & TaskDetails)
  | ({ type: "task_notification"; status: Exclude<TaskStatus, "running"> } & TaskDetails)
  | { type: "background_tasks_changed"; tasks: TaskDetails[] }
  | { type: "task_output"; toolUseId: string; output: string; outputTruncated: boolean }
);

export const TASK_OUTPUT_LIMIT = 4096;

export function isTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export type WorkerEvent =
  | TaskEvent
  | { type: "session"; sessionId: string }
  | { type: "permission_mode"; effectiveMode: string; requestedMode?: string }
  | { type: "permission_denied"; eventId: string; toolUseId: string; toolName: string; agentId?: string; decisionReasonType?: string; decisionReason?: string; message: string }
  | { type: "notice"; eventId: string; message: string; level: "info" | "warning" }
  | { type: "command_init"; commands: string[]; skills?: string[]; terminalCommands?: string[]; cliVersion?: string; subscriptionQuotas?: boolean }
  | { type: "commands_changed"; commands: CommandDescriptor[]; eventId: string }
  | { type: "command_output"; output: CommandOutputPart[]; eventId: string; command?: string; failed?: boolean }
  | { type: "command_lifecycle"; eventId: string; clientMessageId: string; state: "queued" | "started" | "completed" }
  | { type: "input_ack"; clientMessageId: string }
  | { type: "compact_status"; state: "compacting" | "success" | "failed"; error?: string; eventId: string }
  | { type: "compact_boundary"; metadata: CompactMetadata; eventId: string }
  | { type: "rate_limit"; info: RateLimitInfo; eventId: string }
  | { type: "assistant_delta"; text: string; messageId: string; index?: number }
  /** 流式：一条 API 消息开始（apiMessageId = message.id，与转录里 assistant 行的 message.id 相同）。 */
  | { type: "assistant_stream_start"; apiMessageId: string }
  /** 流式：一个 content block 结束。 */
  | { type: "assistant_block_stop"; index: number }
  | { type: "assistant"; text: string; messageId: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; input: Record<string, unknown>; messageId: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean; messageId?: string }
  | ({ type: "result"; subtype: string; isError: boolean; result?: string; errors?: string[]; messageId: string; inputIds?: string[]; turnModelUsage?: Record<string, unknown> } & ResultUsage);

export type InteractionDecision =
  | { type: "allow_once" }
  | { type: "deny"; message?: string }
  | { type: "answer"; answers: Record<string, string> };
