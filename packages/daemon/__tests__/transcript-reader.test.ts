import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseTranscriptLine, readBefore, readTail, readTranscriptUsage, stripWrapperTags } from "../src/transcript/reader.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const basicFile = join(fixturesDir, "-home-alice-projA", "11111111-aaaa-4aaa-8aaa-111111111111.jsonl");
const toolsFile = join(fixturesDir, "-home-alice-projA", "22222222-bbbb-4bbb-8bbb-222222222222.jsonl");
const forkFile = join(fixturesDir, "-home-bob-projB", "33333333-cccc-4ccc-8ccc-333333333333.jsonl");
const emptyFile = join(fixturesDir, "-home-bob-projB", "44444444-dddd-4ddd-8ddd-444444444444.jsonl");
const metaOnlyFile = join(fixturesDir, "-home-bob-projB", "55555555-eeee-4eee-8eee-555555555555.jsonl");

test("readTail returns the full main chain of a plain multi-turn session", async () => {
  const page = await readTail(basicFile, 100);
  assert.deepEqual(page.messages.map((m) => m.seq), [2, 3, 4, 5]);
  assert.deepEqual(page.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(page.messages.every((m) => m.kind === "text"), true);
  assert.equal(page.messages[0]?.text, "帮我看看这个项目的结构，重点是入口文件");
  assert.equal(page.messages[0]?.parentUuid, null);
  assert.equal(page.messages[0]?.timestamp, "2026-07-18T08:00:01.000Z");
  assert.equal(page.firstSeq, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.totalLines, 5);
  assert.equal(page.badLines, 0);
});

test("readTail pagination window and readBefore join up without gaps", async () => {
  const tail = await readTail(basicFile, 2);
  assert.deepEqual(tail.messages.map((m) => m.seq), [4, 5]);
  assert.equal(tail.firstSeq, 4);
  assert.equal(tail.hasMore, true);

  const previous = await readBefore(basicFile, tail.firstSeq ?? 0, 2);
  assert.deepEqual(previous.messages.map((m) => m.seq), [2, 3]);
  assert.equal(previous.hasMore, false);

  const beforeStart = await readBefore(basicFile, 2, 10);
  assert.deepEqual(beforeStart.messages, []);
  assert.equal(beforeStart.firstSeq, null);
  assert.equal(beforeStart.hasMore, false);
});

test("assistant blocks split into thinking/text/tool_use with stable blockIndex", async () => {
  const page = await readTail(toolsFile, 100);
  const line2 = page.messages.filter((m) => m.seq === 2);
  assert.deepEqual(
    line2.map((m) => [m.blockIndex, m.kind]),
    [[0, "thinking"], [1, "text"], [2, "tool_use"], [3, "tool_use"]],
  );
  assert.equal(line2[0]?.text, "用户要看文件列表，用 ls 即可。");
  assert.equal(line2[2]?.toolName, "Bash");
  assert.deepEqual(line2[2]?.toolInput, { command: "ls" });
  assert.equal(line2[2]?.toolUseId, "tu-1");
  assert.equal(line2.every((m) => m.role === "assistant"), true);
});

test("user tool_result blocks keep role user and carry isError", async () => {
  const page = await readTail(toolsFile, 100);
  const line3 = page.messages.filter((m) => m.seq === 3);
  assert.deepEqual(line3.map((m) => [m.blockIndex, m.kind, m.role]), [
    [0, "tool_result", "user"],
    [1, "tool_result", "user"],
  ]);
  assert.equal(line3[0]?.text, "file1.ts\nfile2.ts");
  assert.equal(line3[0]?.isError, false);
  assert.equal(line3[0]?.toolUseId, "tu-1");
  assert.equal(line3[1]?.text, "读取失败：文件不存在");
  assert.equal(line3[1]?.isError, true);
});

test("main chain excludes abandoned fork branch and sidechain lines", async () => {
  const page = await readTail(forkFile, 100);
  assert.deepEqual(page.messages.map((m) => m.seq), [2, 3, 6, 10, 11]);
  const allText = page.messages.map((m) => m.text ?? "").join("|");
  assert.equal(allText.includes("旧分支"), false);
  assert.equal(allText.includes("子代理"), false);
  assert.equal(page.totalLines, 12);
  assert.equal(page.badLines, 1);
});

test("unknown line type with message structure renders as kind meta with rawType", async () => {
  const page = await readTail(forkFile, 100);
  const meta = page.messages.find((m) => m.seq === 10);
  assert.equal(meta?.kind, "meta");
  assert.equal(meta?.rawType, "future-widget");
  assert.equal(meta?.role, "assistant");
  assert.equal(meta?.text, "来自未来版本的未知行");
});

test("paging across a chain that passes through skipped lines stays consistent", async () => {
  const tail = await readTail(forkFile, 3);
  assert.deepEqual(tail.messages.map((m) => m.seq), [6, 10, 11]);
  assert.equal(tail.firstSeq, 6);
  assert.equal(tail.hasMore, true);

  const previous = await readBefore(forkFile, tail.firstSeq ?? 0, 100);
  assert.deepEqual(previous.messages.map((m) => m.seq), [2, 3]);
  assert.equal(previous.hasMore, false);
});

test("empty and metadata-only files yield empty pages without errors", async () => {
  const empty = await readTail(emptyFile, 50);
  assert.deepEqual(empty, { messages: [], firstSeq: null, hasMore: false, totalLines: 0, badLines: 0 });

  const metaOnly = await readTail(metaOnlyFile, 50);
  assert.deepEqual(metaOnly.messages, []);
  assert.equal(metaOnly.firstSeq, null);
  assert.equal(metaOnly.hasMore, false);
  assert.equal(metaOnly.totalLines, 2);
});

test("parseTranscriptLine tolerates hostile input", () => {
  assert.deepEqual(parseTranscriptLine("{not json", 1), []);
  assert.deepEqual(parseTranscriptLine("123", 2), []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "user" }), 3), []);
  // 未知 type 但没有 uuid：无法参与链，跳过
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ type: "odd", message: { role: "user", content: "x" } }), 4),
    [],
  );
  // 剥掉包裹标签后为空的 user 行不产出
  const caveat = {
    type: "user",
    uuid: "u-c",
    parentUuid: null,
    message: { role: "user", content: "<local-command-caveat>内部提示</local-command-caveat>" },
  };
  assert.deepEqual(parseTranscriptLine(JSON.stringify(caveat), 5), []);
  // isMeta / sidechain 行不产出
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ ...caveat, message: { role: "user", content: "正文" }, isMeta: true }), 6),
    [],
  );
  assert.deepEqual(
    parseTranscriptLine(JSON.stringify({ ...caveat, message: { role: "user", content: "正文" }, isSidechain: true }), 7),
    [],
  );
});

test("stripWrapperTags removes known CLI wrapper tags but keeps user text", () => {
  const mixed = "<command-name>/clear</command-name>\n<command-message>clear</command-message>";
  assert.equal(stripWrapperTags(mixed).trim(), "");
  const withText = "<system-reminder>背景</system-reminder>请帮我修这个 bug";
  assert.equal(stripWrapperTags(withText).trim(), "请帮我修这个 bug");
  assert.equal(stripWrapperTags("普通 <b>加粗</b> 文本").trim(), "普通 <b>加粗</b> 文本");
});

test("task-notification 不产生用户消息，混排时保留真正的用户文本", () => {
  const notification = "<task-notification>\n<task-id>task-1</task-id>\n<summary>Task stopped</summary>\n</task-notification>";
  const line = (content: unknown) => JSON.stringify({ type: "user", uuid: "notification", message: { role: "user", content } });
  assert.deepEqual(parseTranscriptLine(line(notification), 1), []);
  assert.deepEqual(parseTranscriptLine(line([{ type: "text", text: notification }]), 2), []);
  const mixed = `之前\n${notification}\n之后`;
  assert.equal(stripWrapperTags(mixed), "之前\n\n之后");
  assert.deepEqual(parseTranscriptLine(line(mixed), 3).map((message) => message.text), ["之前\n\n之后"]);
  assert.deepEqual(parseTranscriptLine(line([
    { type: "text", text: notification }, { type: "text", text: "实际提问" },
  ]), 4).map((message) => [message.blockIndex, message.text]), [[1, "实际提问"]]);
});

test("assistant upstream message id survives parsing with original block indexes", () => {
  const messages = parseTranscriptLine(JSON.stringify({
    type: "assistant", uuid: "row-id", parentUuid: "user-id",
    message: { id: "msg_upstream", content: [
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "好的" },
      { type: "text", text: "好的" },
    ] },
  }), 2);
  assert.deepEqual(messages.map((m) => [m.apiMessageId, m.blockIndex]), [
    ["msg_upstream", 0], ["msg_upstream", 1], ["msg_upstream", 2],
  ]);
  assert.equal(messages[0]?.uuid, "row-id");
});

test("P1 native and legacy command results survive history pagination without leaking reminders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cr-p1-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fixture.jsonl");
  const assistant = { role: "assistant", id: "api-1", content: [{ type: "text", text: "reply" }],
    usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } };
  const lines = [
    { type: "user", uuid: "u", parentUuid: null, message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "a1", parentUuid: "u", message: assistant },
    { type: "assistant", uuid: "a2", parentUuid: "a1", message: assistant },
    { type: "assistant", uuid: "side", parentUuid: "a2", isSidechain: true, message: { ...assistant, id: "api-side" } },
    { type: "user", uuid: "old", parentUuid: "a2", message: { role: "user", content: [
      { type: "text", text: "<task-notification><local-command-stdout>hidden</local-command-stdout></task-notification>real user" },
      { type: "text", text: "<local-command-stdout>one\ntwo<system-reminder>hidden</system-reminder></local-command-stdout>\n<local-command-stderr>notice</local-command-stderr>" },
    ] } },
    { type: "system", subtype: "local_command", uuid: "native", parentUuid: "old", isMeta: true,
      content: "<local-command-stdout>native output</local-command-stdout>" },
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: "native",
      compactMetadata: { trigger: "manual", preTokens: 400, postTokens: 100, durationMs: 30 } },
    { type: "cost-state", sessionId: "fixture", totalCostUSD: 0.2, modelUsage: { sonnet: { inputTokens: 12 } } },
    { type: "cost-state", sessionId: "fixture", totalCostUSD: 0.3, modelUsage: { sonnet: { inputTokens: 24 } } },
    { type: "cost-state", sessionId: "different", totalCostUSD: 9 },
  ];
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  const tail = await readTail(file, 2);
  assert.deepEqual(tail.messages.map(({ kind }) => kind), ["command_output", "compact_boundary"]);
  assert.equal(tail.messages[0]?.text, "native output");
  assert.deepEqual(tail.messages[1]?.compactMetadata, { trigger: "manual", pre_tokens: 400, post_tokens: 100, duration_ms: 30 });
  const previous = await readBefore(file, tail.firstSeq!, 10);
  assert.equal(previous.messages.find(({ uuid }) => uuid === "a2")?.usage?.input_tokens, 12);
  assert.deepEqual(previous.messages.filter(({ uuid }) => uuid === "old").map(({ role, text, output }) => ({ role, text, output })), [
    { role: "user", text: "real user", output: undefined },
    { role: "assistant", text: "one\ntwo\nnotice", output: [{ stream: "stdout", text: "one\ntwo" }, { stream: "stderr", text: "notice" }] },
  ]);
  await appendFile(file, JSON.stringify({ type: "user", uuid: "after", parentUuid: "native",
    message: { role: "user", content: "after compact" } }) + "\n");
  assert.deepEqual((await readTail(file, 2)).messages.map(({ kind }) => kind), ["compact_boundary", "text"]);
  assert.deepEqual(await readTranscriptUsage(file, "fixture"), {
    mainAgent: { source: "transcript", apiResponses: 1,
      usage: { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
    sdkSession: { source: "sdk_estimate", scope: "session", total_cost_usd: 0.3, modelUsage: { sonnet: { inputTokens: 24 } } },
  });
});
