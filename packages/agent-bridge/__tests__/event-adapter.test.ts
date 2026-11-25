import assert from "node:assert/strict";
import test from "node:test";
import { adaptSdkMessage } from "../src/event-adapter.js";
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

test("stream events: message_start / block index / block_stop; subagent streams skipped", () => {
  const start = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } }, uuid: "e1", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(start[1], { type: "assistant_stream_start", apiMessageId: "msg_1" });
  const delta = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "x" } }, uuid: "e2", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(delta[1], { type: "assistant_delta", text: "x", messageId: "e2", index: 2 });
  const stop = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_stop", index: 2 }, uuid: "e3", session_id: "s", parent_tool_use_id: null }));
  assert.deepEqual(stop[1], { type: "assistant_block_stop", index: 2 });
  const sub = adaptSdkMessage(sdk({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y" } }, uuid: "e4", session_id: "s", parent_tool_use_id: "tu1" }));
  assert.equal(sub.length, 1);
});

test("SDK mode facts preserve unknown values and ignore missing or subagent state", () => {
  for (const subtype of ["init", "status"]) {
    assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype, permissionMode: "auto" })), [{ type: "permission_mode", effectiveMode: "auto" }]);
    assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype, permissionMode: "future-mode" })), [{ type: "permission_mode", effectiveMode: "future-mode" }]);
    assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype })), []);
    assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype, permissionMode: "default", agent_id: "child" })), []);
  }
});

test("auto denial retains tool and agent identity; user notices exclude internal events", () => {
  const denial = { type: "system", subtype: "permission_denied", uuid: "deny-1", tool_use_id: "tool-1", tool_name: "Bash", agent_id: "child", decision_reason_type: "classifier", decision_reason: "Needs explicit authorization", message: "Denied" };
  assert.deepEqual(adaptSdkMessage(sdk(denial)), [{ type: "permission_denied", eventId: "deny-1", toolUseId: "tool-1", toolName: "Bash", agentId: "child", decisionReasonType: "classifier", decisionReason: "Needs explicit authorization", message: "Denied" }]);
  assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype: "informational", uuid: "notice-1", content: "Review may incur usage", level: "warning" })), [{ type: "notice", eventId: "notice-1", message: "Review may incur usage", level: "warning" }]);
  assert.deepEqual(adaptSdkMessage(sdk({ type: "system", subtype: "thinking_tokens", content: "internal", uuid: "internal" })), []);
});

test("task edges preserve SDK identity, task metadata and usage without exposing output_file", () => {
  const base = { type: "system", task_id: "agent-1", tool_use_id: "tool-1" };
  const usage = { total_tokens: 200, tool_uses: 3, duration_ms: 1200 };
  const started = adaptSdkMessage(sdk({
    ...base, subtype: "task_started", uuid: "start", task_type: "local_agent", subagent_type: "review",
    description: "Review files", workflow_name: "workflow", skip_transcript: true, prompt: "private prompt",
  }))[0];
  assert.ok(started?.type === "task_started");
  assert.ok(Number.isSafeInteger(started.observedAt));
  assert.deepEqual(started, {
    type: "task_started", eventId: "start", observedAt: started.observedAt,
    taskId: "agent-1", toolUseId: "tool-1", status: "running", taskType: "local_agent", subagentType: "review",
    description: "Review files", workflowName: "workflow", skipTranscript: true,
  });

  const progress = adaptSdkMessage(sdk({
    ...base, subtype: "task_progress", uuid: "progress", description: "Review files", usage,
    last_tool_name: "Read", summary: "Reviewing", timestamp: "2026-11-25T10:00:00.000Z",
  }))[0];
  assert.ok(progress?.type === "task_progress");
  assert.deepEqual(progress.usage, { totalTokens: 200, toolUses: 3, durationMs: 1200 });
  assert.equal(progress.lastToolName, "Read");
  assert.equal(progress.summary, "Reviewing");
  assert.equal(progress.timestamp, "2026-11-25T10:00:00.000Z");

  for (const status of ["completed", "failed", "stopped"]) {
    const notification = adaptSdkMessage(sdk({
      ...base, subtype: "task_notification", uuid: status, status, usage, summary: "s".repeat(5000), output_file: "/tmp/result.txt",
    }))[0];
    assert.ok(notification?.type === "task_notification");
    assert.equal(notification.status, status);
    assert.equal(notification.summary?.length, 4096);
    assert.equal("output_file" in notification, false);
    assert.equal("output" in notification, false);
  }
});

test("background level preserves an empty set and rejects malformed replacements", () => {
  const base = { type: "system", subtype: "background_tasks_changed", uuid: "level" };
  const active = adaptSdkMessage(sdk({ ...base, tasks: [{ task_id: "b01", task_type: "local_bash", description: "Build" }] }))[0];
  assert.ok(active?.type === "background_tasks_changed");
  assert.deepEqual(active.tasks, [{ taskId: "b01", taskType: "local_bash", description: "Build" }]);
  const empty = adaptSdkMessage(sdk({ ...base, tasks: [] }))[0];
  assert.ok(empty?.type === "background_tasks_changed");
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(adaptSdkMessage(sdk({ ...base, tasks: [{ task_id: "bad/path" }] })), []);
  assert.deepEqual(adaptSdkMessage(sdk({ ...base, tasks: null })), []);
});

test("child assistant messages expose a bounded preview keyed to the parent tool", () => {
  const output = adaptSdkMessage(sdk({
    type: "assistant", uuid: "child-message", parent_tool_use_id: "agent-tool", timestamp: "2026-11-25T10:00:00.000Z",
    message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "x".repeat(5000) }] },
  })).find((event) => event.type === "task_output");
  assert.ok(output);
  assert.equal(output.toolUseId, "agent-tool");
  assert.equal(output.eventId, "child-message");
  assert.equal(output.output, "x".repeat(4096));
  assert.equal(output.outputTruncated, true);
});
