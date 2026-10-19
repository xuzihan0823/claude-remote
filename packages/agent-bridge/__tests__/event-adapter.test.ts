import assert from "node:assert/strict";
import test from "node:test";
import { adaptSdkMessage, createStreamTracker } from "../src/event-adapter.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const sdk = (value: unknown): SDKMessage => value as SDKMessage;

test("adapts streaming assistant and structured tool_use without SDK passthrough", () => {
  const delta = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, uuid: "m1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(delta[1], { type: "assistant_delta", text: "hi", messageId: "m1" });
  const events = adaptSdkMessage(sdk({ type: "assistant", message: { content: [{ type: "text", text: "done" }, { type: "tool_use", id: "tu", name: "Read", input: { file_path: "x" } }] }, uuid: "m2", session_id: "s", parent_tool_use_id: null }));
  assert.equal(events.some((event) => event.type === "assistant"), true);
  assert.deepEqual(events.find((event) => event.type === "tool_use"), { type: "tool_use", toolUseId: "tu", toolName: "Read", input: { file_path: "x" }, messageId: "m2" });
});

test("adapts tool_result and result", () => {
  const tool = adaptSdkMessage(sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu", content: "ok" }] }, uuid: "u1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(tool[1], { type: "tool_result", toolUseId: "tu", content: "ok", isError: false, messageId: "u1" });
  const result = adaptSdkMessage(sdk({ type: "result", subtype: "success", is_error: false, result: "yes", uuid: "r1", session_id: "s" }));
  assert.deepEqual(result[1], { type: "result", subtype: "success", isError: false, result: "yes", messageId: "r1" });
});

test("stream tracker keys deltas by api message id and block index across messages", () => {
  const tracker = createStreamTracker();
  const stream = (event: Record<string, unknown>, uuid: string): SDKMessage =>
    sdk({ type: "stream_event", event, uuid, session_id: "s", parent_tool_use_id: null });
  const deltas: unknown[] = [];
  const collect = (message: SDKMessage): void => {
    for (const event of adaptSdkMessage(message, tracker)) {
      if (event.type === "assistant_delta") deltas.push(event);
    }
  };

  collect(stream({ type: "message_start", message: { id: "msg_A" } }, "stream-1"));
  collect(stream({ type: "content_block_start", index: 0 }, "stream-2"));
  collect(stream({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }, "stream-3"));
  collect(stream({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } }, "stream-4"));
  collect(stream({ type: "content_block_start", index: 1 }, "stream-5"));
  collect(stream({ type: "content_block_delta", delta: { type: "text_delta", text: "second" } }, "stream-6"));
  collect(stream({ type: "message_start", message: { id: "msg_B" } }, "stream-7"));
  collect(stream({ type: "content_block_delta", delta: { type: "text_delta", text: "again" } }, "stream-8"));

  assert.deepEqual(deltas, [
    { type: "assistant_delta", text: "Hello ", messageId: "stream-3", apiMessageId: "msg_A", blockIndex: 0 },
    { type: "assistant_delta", text: "world", messageId: "stream-4", apiMessageId: "msg_A", blockIndex: 0 },
    { type: "assistant_delta", text: "second", messageId: "stream-6", apiMessageId: "msg_A", blockIndex: 1 },
    { type: "assistant_delta", text: "again", messageId: "stream-8", apiMessageId: "msg_B", blockIndex: 0 },
  ]);
});

test("without a tracker deltas keep the legacy shape", () => {
  const events = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, uuid: "m1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(events[1], { type: "assistant_delta", text: "hi", messageId: "m1" });
  assert.equal(Object.hasOwn(events[1] as object, "apiMessageId"), false);
  assert.equal(Object.hasOwn(events[1] as object, "blockIndex"), false);
});

test("stream events from subagents do not produce deltas", () => {
  const tracker = createStreamTracker();
  const events = adaptSdkMessage(sdk({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hidden" } },
    uuid: "m1",
    session_id: "s",
    parent_tool_use_id: "tu_subagent",
  }), tracker);
  assert.equal(events.some((event) => event.type === "assistant_delta"), false);
});
