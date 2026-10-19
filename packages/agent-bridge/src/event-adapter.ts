import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerEvent } from "./types.js";

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

export interface StreamTracker {
  apiMessageId?: string;
  blockIndex: number;
}

export function createStreamTracker(): StreamTracker {
  return { blockIndex: 0 };
}

export function adaptSdkMessage(message: SDKMessage, tracker?: StreamTracker): WorkerEvent[] {
  const source = message as unknown as Record<string, unknown>;
  const sessionId = typeof source.session_id === "string" ? source.session_id : undefined;
  const events: WorkerEvent[] = sessionId === undefined ? [] : [{ type: "session", sessionId }];

  if (message.type === "stream_event") {
    const parentToolUseId = source.parent_tool_use_id;
    if (typeof parentToolUseId === "string" && parentToolUseId.length > 0) return events;
    const event = message.event as unknown as Record<string, unknown>;
    if (tracker !== undefined) {
      if (event.type === "message_start") {
        const apiMessage = record(event.message);
        if (typeof apiMessage?.id === "string" && apiMessage.id.length > 0) tracker.apiMessageId = apiMessage.id;
        tracker.blockIndex = 0;
      } else if (event.type === "content_block_start") {
        if (typeof event.index === "number" && Number.isInteger(event.index) && event.index >= 0) tracker.blockIndex = event.index;
      }
    }
    if (event.type === "content_block_delta") {
      const delta = record(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        events.push(tracker === undefined
          ? { type: "assistant_delta", text: delta.text, messageId: message.uuid }
          : {
            type: "assistant_delta",
            text: delta.text,
            messageId: message.uuid,
            ...(tracker.apiMessageId === undefined ? {} : { apiMessageId: tracker.apiMessageId }),
            blockIndex: tracker.blockIndex,
          });
      }
    }
    return events;
  }

  if (message.type === "assistant") {
    const content = (message.message as unknown as { content?: unknown }).content;
    const text = contentText(content);
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
    events.push({
      type: "result",
      subtype: message.subtype,
      isError: message.is_error,
      ...(message.subtype === "success" ? { result: message.result } : { errors: message.errors }),
      messageId: message.uuid,
    });
  }
  return events;
}
