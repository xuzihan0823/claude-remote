import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { localCommandOutput } from "./command-output.js";
import { isTaskId, TASK_OUTPUT_LIMIT, type TaskDetails, type TaskEvent, type WorkerEvent } from "./types.js";

function taskEventIdentity(source: Record<string, unknown>) {
  if (typeof source.uuid !== "string" || !source.uuid) return;
  return {
    eventId: source.uuid,
    observedAt: Date.now(),
    ...(typeof source.timestamp === "string" && Number.isFinite(Date.parse(source.timestamp)) ? { timestamp: source.timestamp } : {}),
  };
}

function taskDetails(source: Record<string, unknown>): TaskDetails | undefined {
  if (typeof source.task_id !== "string" || !isTaskId(source.task_id)) return;
  const raw = record(source.usage);
  const { total_tokens: totalTokens, tool_uses: toolUses, duration_ms: durationMs } = raw ?? {};
  const usage = typeof totalTokens === "number" && typeof toolUses === "number" && typeof durationMs === "number" &&
    [totalTokens, toolUses, durationMs].every((n) => Number.isSafeInteger(n) && n >= 0) ? { totalTokens, toolUses, durationMs } : undefined;
  return {
    taskId: source.task_id,
    ...(typeof source.task_type === "string" ? { taskType: source.task_type.slice(0, 128) } : {}),
    ...(typeof source.subagent_type === "string" ? { subagentType: source.subagent_type.slice(0, 128) } : {}),
    ...(typeof source.workflow_name === "string" ? { workflowName: source.workflow_name.slice(0, 256) } : {}),
    ...(typeof source.description === "string" ? { description: source.description.slice(0, 1024) } : {}),
    ...(typeof source.tool_use_id === "string" ? { toolUseId: source.tool_use_id } : {}),
    ...(typeof source.last_tool_name === "string" ? { lastToolName: source.last_tool_name.slice(0, 256) } : {}),
    ...(typeof source.summary === "string" ? { summary: source.summary.slice(0, TASK_OUTPUT_LIMIT) } : {}),
    ...(typeof source.skip_transcript === "boolean" ? { skipTranscript: source.skip_transcript } : {}),
    ...(usage ? { usage } : {}),
  };
}

function adaptTaskSystemEvent(message: Extract<SDKMessage, { type: "system" }>, source: Record<string, unknown>): TaskEvent | undefined {
  const { subtype } = message;
  if (subtype !== "task_started" && subtype !== "task_progress" && subtype !== "task_notification" && subtype !== "background_tasks_changed") return;
  const identity = taskEventIdentity(source);
  if (!identity) return;
  if (subtype === "background_tasks_changed") {
    if (source.agent_id || source.parent_tool_use_id || !Array.isArray(message.tasks)) return;
    const tasks: TaskDetails[] = [];
    for (const entry of message.tasks) {
      const item = record(entry);
      const task = item && taskDetails(item);
      if (!task) return;
      tasks.push(task);
    }
    return { type: subtype, ...identity, tasks };
  }
  const details = taskDetails(source);
  if (!details) return;
  if (subtype !== "task_notification") return { type: subtype, ...identity, ...details, status: "running" };
  const { status } = message;
  if (status === "completed" || status === "failed" || status === "stopped") return { type: subtype, ...identity, ...details, status };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => {
    const item = record(part);
    if (item?.type === "text" && typeof item.text === "string") return item.text;
    if (typeof item?.content === "string") return item.content;
    if (Array.isArray(item?.content)) return contentText(item.content);
    return "";
  }).join("");
  const item = record(value);
  return typeof item?.text === "string" ? item.text : "";
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export function adaptSdkMessage(message: SDKMessage): WorkerEvent[] {
  const source = message as unknown as Record<string, unknown>;
  const sessionId = typeof source.session_id === "string" ? source.session_id : undefined;
  const events: WorkerEvent[] = sessionId === undefined ? [] : [{ type: "session", sessionId }];

  if (source.type === "command_lifecycle" && typeof source.uuid === "string" && typeof source.command_uuid === "string"
    && (source.state === "queued" || source.state === "started" || source.state === "completed")) {
    events.push({ type: "command_lifecycle", eventId: source.uuid, clientMessageId: source.command_uuid, state: source.state });
  }

  if (message.type === "system") {
    const task = adaptTaskSystemEvent(message, source);
    if (task) events.push(task);
    const fromMain = !source.agent_id && !source.parent_tool_use_id;
    if (fromMain && message.subtype === "init") {
      const commands = strings(message.slash_commands);
      const skills = strings(message.skills);
      const terminalCommands = strings(source.terminal_slash_commands);
      const apiKeySource = source.apiKeySource;
      const subscriptionQuotas = source.served_by_anthropic === false ? false
        : typeof apiKeySource === "string" ? apiKeySource === "oauth" : undefined;
      if (commands) events.push({
        type: "command_init", commands,
        ...(skills === undefined ? {} : { skills }),
        ...(terminalCommands === undefined ? {} : { terminalCommands }),
        ...(subscriptionQuotas === undefined ? {} : { subscriptionQuotas }),
        ...(typeof message.claude_code_version === "string" ? { cliVersion: message.claude_code_version } : {}),
      });
    } else if (fromMain && message.subtype === "commands_changed" && Array.isArray(message.commands)) {
      events.push({ type: "commands_changed", commands: message.commands, eventId: message.uuid });
    } else if (fromMain && message.subtype === "local_command_output" && typeof message.content === "string") {
      const output = localCommandOutput(message.content);
      if (output.length > 0) events.push({ type: "command_output", output, eventId: message.uuid });
    } else if (fromMain && message.subtype === "compact_boundary" && message.compact_metadata) {
      const { trigger, pre_tokens } = message.compact_metadata;
      if ((trigger === "manual" || trigger === "auto") && Number.isSafeInteger(pre_tokens) && pre_tokens >= 0) {
        events.push({ type: "compact_boundary", metadata: message.compact_metadata, eventId: message.uuid });
      }
    } else if (fromMain && message.subtype === "status") {
      const state = message.compact_result ?? (message.status === "compacting" ? "compacting" : undefined);
      if (state === "compacting" || state === "success" || state === "failed") events.push({
        type: "compact_status", state, eventId: message.uuid,
        ...(typeof message.compact_error === "string" ? { error: message.compact_error } : {}),
      });
    }
    if ((source.subtype === "init" || source.subtype === "status") && !source.agent_id && !source.parent_tool_use_id
      && typeof source.permissionMode === "string" && source.permissionMode !== "") {
      events.push({ type: "permission_mode", effectiveMode: source.permissionMode });
    } else if (source.subtype === "permission_denied" && typeof source.uuid === "string"
      && typeof source.tool_use_id === "string" && typeof source.tool_name === "string" && typeof source.message === "string") {
      events.push({
        type: "permission_denied", eventId: source.uuid, toolUseId: source.tool_use_id,
        toolName: source.tool_name, message: source.message,
        ...(typeof source.agent_id === "string" ? { agentId: source.agent_id } : {}),
        ...(typeof source.decision_reason_type === "string" ? { decisionReasonType: source.decision_reason_type } : {}),
        ...(typeof source.decision_reason === "string" ? { decisionReason: source.decision_reason } : {}),
      });
    } else if (source.subtype === "informational" && typeof source.uuid === "string"
      && typeof source.content === "string" && ["info", "notice", "suggestion", "warning"].includes(String(source.level))) {
      events.push({ type: "notice", eventId: source.uuid, message: source.content, level: source.level === "warning" ? "warning" : "info" });
    }
    return events;
  }

  if (message.type === "stream_event") {
    // 子代理（Task）的流不在主链上，手机端只流式显示主会话
    if (source.parent_tool_use_id) return events;
    const event = message.event as unknown as Record<string, unknown>;
    const index = typeof event.index === "number" ? event.index : undefined;
    if (event.type === "message_start") {
      const id = record(event.message)?.id;
      if (typeof id === "string") events.push({ type: "assistant_stream_start", apiMessageId: id });
    } else if (event.type === "content_block_delta") {
      const delta = record(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        events.push({ type: "assistant_delta", text: delta.text, messageId: message.uuid, ...(index === undefined ? {} : { index }) });
      }
    } else if (event.type === "content_block_stop" && index !== undefined) {
      events.push({ type: "assistant_block_stop", index });
    }
    return events;
  }

  if (message.type === "rate_limit_event" && message.rate_limit_info && typeof message.uuid === "string") {
    events.push({ type: "rate_limit", info: message.rate_limit_info, eventId: message.uuid });
    return events;
  }

  if (message.type === "assistant") {
    // Some CLI builds encode local output as a synthetic assistant with a source wrapper.
    if (!message.parent_tool_use_id && typeof source.local_command_source === "string") {
      const command = record(source.local_command_run)?.command;
      const failed = record(source.local_command_outcome)?.kind === "failed";
      const output = localCommandOutput(source.local_command_source);
      if (output.length > 0) events.push({
        type: "command_output", output, eventId: message.uuid,
        ...(typeof command === "string" ? { command } : {}),
        ...(failed ? { failed } : {}),
      });
      return events;
    }
    const content = (message.message as unknown as { content?: unknown }).content;
    const text = contentText(content);
    if (message.parent_tool_use_id) {
      const identity = taskEventIdentity(source);
      if (text && identity) events.push({
        type: "task_output", ...identity, toolUseId: message.parent_tool_use_id,
        output: text.slice(0, TASK_OUTPUT_LIMIT), outputTruncated: text.length > TASK_OUTPUT_LIMIT,
      });
    }
    if (text) events.push({ type: "assistant", text, messageId: message.uuid });
    if (Array.isArray(content)) {
      for (const part of content) {
        const item = record(part);
        if (item?.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string" && record(item.input)) {
          events.push({ type: "tool_use", toolUseId: item.id, toolName: item.name, input: item.input as Record<string, unknown>, messageId: message.uuid });
        }
      }
    }
    return events;
  }

  if (message.type === "user") {
    if (source.isReplay === true && !message.parent_tool_use_id && typeof message.uuid === "string") {
      events.push({ type: "input_ack", clientMessageId: message.uuid });
    }
    const content = (message.message as unknown as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const item = record(part);
        if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
          const event: WorkerEvent = {
            type: "tool_result",
            toolUseId: item.tool_use_id,
            content: contentText(item.content),
            isError: item.is_error === true,
            ...(message.uuid === undefined ? {} : { messageId: message.uuid }),
          };
          events.push(event);
        }
      }
    }
    return events;
  }

  if (message.type === "result") {
    const turnModelUsage = record(source.model_usage_since_last_result);
    const inputIds = strings(source.user_message_uuids) ?? (typeof source.user_message_uuid === "string" ? [source.user_message_uuid] : undefined);
    events.push({
      type: "result",
      subtype: message.subtype,
      isError: message.is_error,
      ...(message.subtype === "success" ? { result: message.result } : { errors: message.errors }),
      messageId: message.uuid,
      ...(inputIds === undefined ? {} : { inputIds }),
      ...(record(message.usage) ? { usage: message.usage } : {}),
      ...(record(message.modelUsage) ? { modelUsage: message.modelUsage } : {}),
      ...(turnModelUsage ? { turnModelUsage } : {}),
      ...(Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0 ? { total_cost_usd: message.total_cost_usd } : {}),
    });
  }
  return events;
}
