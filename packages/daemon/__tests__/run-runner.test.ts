// TurnRunner：事件流、互斥、abort、completion 不逃逸。全部走 fake QueryFactory，不碰真 SDK。

import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";

import { adaptSdkMessage, type PermissionBroker, type QueryFactory, type WorkerEvent } from "@claude-remote/agent-bridge";
import { NotIdleError, TurnRunner, type ActivityGate, type RunEvent } from "../src/run/runner.js";

type QueryParams = Parameters<QueryFactory>[0];
type SdkQuery = ReturnType<QueryFactory>;
type AnySdkMessage = Parameters<typeof adaptSdkMessage>[0];

interface FakeState {
  params: QueryParams | undefined;
  interrupts: number;
  closes: number;
  onInterrupt: (() => void) | undefined;
}

/** 最小 fake：async generator 充当 Query，只补 sdk-bridge 用到的 interrupt/close。 */
function fakeFactory(
  produce: (state: FakeState) => AsyncGenerator<AnySdkMessage, void>,
): { factory: QueryFactory; state: FakeState } {
  const state: FakeState = { params: undefined, interrupts: 0, closes: 0, onInterrupt: undefined };
  const factory = ((params: QueryParams): SdkQuery => {
    state.params = params;
    const generator = produce(state);
    const augmented = generator as unknown as Record<string, unknown>;
    augmented.interrupt = async (): Promise<void> => {
      state.interrupts += 1;
      state.onInterrupt?.();
    };
    augmented.close = (): void => {
      state.closes += 1;
    };
    return generator as unknown as SdkQuery;
  }) as unknown as QueryFactory;
  return { factory, state };
}

function sdkMessage(value: Record<string, unknown>): AnySdkMessage {
  return value as unknown as AnySdkMessage;
}

function assistantMessage(text: string, uuid: string, sessionId: string): AnySdkMessage {
  return sdkMessage({ type: "assistant", uuid, session_id: sessionId, message: { content: [{ type: "text", text }] } });
}

function resultMessage(result: string, uuid: string, sessionId: string): AnySdkMessage {
  return sdkMessage({ type: "result", subtype: "success", is_error: false, result, uuid, session_id: sessionId });
}

function streamEvent(uuid: string, sessionId: string, event: Record<string, unknown>): AnySdkMessage {
  return sdkMessage({ type: "stream_event", uuid, session_id: sessionId, event });
}

async function nextDeltas(
  iterator: AsyncIterator<RunEvent>,
  count: number,
): Promise<Array<Extract<WorkerEvent, { type: "assistant_delta" }>>> {
  const deltas: Array<Extract<WorkerEvent, { type: "assistant_delta" }>> = [];
  while (deltas.length < count) {
    const next = await iterator.next();
    if (next.done) assert.fail("event stream ended before expected deltas");
    if (next.value.type === "worker" && next.value.event.type === "assistant_delta") deltas.push(next.value.event);
  }
  return deltas;
}

function stubGate(isIdle: (sessionId: string) => boolean = () => true): {
  gate: ActivityGate;
  begun: string[];
  ended: string[];
} {
  const begun: string[] = [];
  const ended: string[] = [];
  const gate: ActivityGate = {
    isIdle,
    beginRun: (sessionId) => { begun.push(sessionId); },
    endRun: (sessionId) => { ended.push(sessionId); },
  };
  return { gate, begun, ended };
}

const denyAll: PermissionBroker = { request: async () => ({ type: "deny" }) };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

test("normal turn: started → worker events → done，completion settle，gate/close 收尾", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield assistantMessage("你好", "m1", "sess-1");
    yield resultMessage("完成", "r1", "sess-1");
  });
  const { gate, begun, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-1", cwd: "/tmp", text: "继续" });

  const events = await collect(handle.events);
  assert.deepEqual(await handle.completion, { state: "done" });

  assert.deepEqual(events[0], { type: "run", runId: handle.runId, sessionId: "sess-1", state: "started" });
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "sess-1", state: "done" });
  const workerTypes = events.filter((e) => e.type === "worker").map((e) => e.event.type);
  assert.deepEqual(workerTypes, ["session", "assistant", "session", "result"]);

  assert.deepEqual(begun, ["sess-1"]);
  assert.deepEqual(ended, ["sess-1"]);
  assert.equal(state.closes, 1);

  // resume 接线：resume=sessionId、permissionMode 固定 default、prompt 经输入流送达
  const options = state.params?.options;
  assert.equal(options?.resume, "sess-1");
  assert.equal(options?.permissionMode, "default");
  const input = state.params?.prompt as AsyncIterable<{ message: { content: unknown } }>;
  const first = await input[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "继续");
});

test("new session uses explicit sessionId and model instead of resume", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield resultMessage("完成", "r1", "01234567-89ab-4def-8123-456789abcdef");
  });
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({
    sessionId: "01234567-89ab-4def-8123-456789abcdef",
    cwd: "/tmp",
    text: "新会话",
    model: "fable",
    newSession: true,
  });
  await handle.completion;

  const options = state.params?.options as Record<string, unknown> | undefined;
  assert.equal(options?.sessionId, "01234567-89ab-4def-8123-456789abcdef");
  assert.equal(options?.model, "fable");
  assert.equal(Object.hasOwn(options ?? {}, "resume"), false);
  assert.throws(() => runner.startTurn({ sessionId: "not-a-uuid", cwd: "/tmp", text: "x", newSession: true }), TypeError);
});

test("permissionMode 透传 sdkOptions 且随 started 事件广播；省略时事件不带该字段", async () => {
  const { factory, state } = fakeFactory(async function* () {
    yield resultMessage("完成", "r1", "sess-pm");
  });
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-pm", cwd: "/tmp", text: "继续", permissionMode: "acceptEdits" });

  const events = await collect(handle.events);
  assert.deepEqual(events[0], {
    type: "run", runId: handle.runId, sessionId: "sess-pm", state: "started", permissionMode: "acceptEdits",
  });
  assert.equal(state.params?.options?.permissionMode, "acceptEdits");

  // 省略 permissionMode：started 事件不带字段（前端按本地记忆展示）
  const second = fakeFactory(async function* () {
    yield resultMessage("完成", "r2", "sess-pm2");
  });
  const runner2 = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: second.factory });
  const handle2 = runner2.startTurn({ sessionId: "sess-pm2", cwd: "/tmp", text: "继续" });
  const events2 = await collect(handle2.events);
  assert.deepEqual(events2[0], { type: "run", runId: handle2.runId, sessionId: "sess-pm2", state: "started" });
});

test("gate 非 idle：抛 NotIdleError 且不 beginRun、不建 SDK query", () => {
  const { gate, begun } = stubGate(() => false);
  const factory = ((): SdkQuery => {
    throw new Error("queryFactory must not be called");
  }) as unknown as QueryFactory;
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  assert.throws(() => runner.startTurn({ sessionId: "busy", cwd: "/tmp", text: "hi" }), NotIdleError);
  assert.deepEqual(begun, []);
});

test("空 text 抛 TypeError，不触发 gate", () => {
  const { gate, begun } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll });
  assert.throws(() => runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "  " }), TypeError);
  assert.deepEqual(begun, []);
});

test("同会话并发=1：活跃 run 期间重复 startTurn 抛 NotIdleError（即便 gate 报 idle）", async () => {
  const stop = deferred();
  const { factory, state } = fakeFactory(async function* () {
    await stop.promise;
  });
  state.onInterrupt = () => stop.resolve();
  const { gate } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });

  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.throws(() => runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "again" }), NotIdleError);

  runner.abort(handle.runId);
  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });

  // run 结束后会话解锁，可再次 startTurn（stop 已 resolve，新 query 立即结束）
  const second = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.deepEqual(await second.completion, { state: "done" });
});

test("不同会话可并行，各自 begin/end", async () => {
  const releases: Array<() => void> = [];
  const { factory } = fakeFactory(async function* () {
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const { gate, begun, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });

  const a = runner.startTurn({ sessionId: "sess-a", cwd: "/tmp", text: "hi" });
  const b = runner.startTurn({ sessionId: "sess-b", cwd: "/tmp", text: "hi" });
  assert.deepEqual(begun, ["sess-a", "sess-b"]);

  // 等两个生成器都挂起后放行
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  for (const release of releases) release();
  assert.deepEqual(await a.completion, { state: "done" });
  assert.deepEqual(await b.completion, { state: "done" });
  assert.deepEqual([...ended].sort(), ["sess-a", "sess-b"]);
});

test("abort：调 SDK interrupt、终态 run error=aborted、endRun 收尾", async () => {
  const stop = deferred();
  const { factory, state } = fakeFactory(async function* () {
    yield assistantMessage("前半", "m1", "s");
    await stop.promise;
  });
  state.onInterrupt = () => stop.resolve();
  const { gate, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });

  assert.equal(runner.abort("nonexistent-run"), false);
  assert.equal(runner.abort(handle.runId), true);

  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });
  const events = await collect(handle.events);
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "error", error: "aborted" });
  assert.equal(state.interrupts, 1);
  assert.deepEqual(ended, ["s"]);
});

test("SDK 流中抛错：completion 不逃逸（unhandledRejection 探针零命中）", async () => {
  const seen: unknown[] = [];
  const probe = (reason: unknown): void => { seen.push(reason); };
  process.on("unhandledRejection", probe);
  try {
    const { factory } = fakeFactory(async function* () {
      yield assistantMessage("a", "m1", "s");
      throw new Error("boom");
    });
    const { gate, ended } = stubGate();
    const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
    const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });

    // 故意先不 await completion，把微任务/宏任务队列都排空，验证没有 rejection 逃逸
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(seen, []);

    assert.deepEqual(await handle.completion, { state: "error", error: "boom" });
    const events = await collect(handle.events);
    assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "error", error: "boom" });
    assert.deepEqual(ended, ["s"]);
  } finally {
    process.off("unhandledRejection", probe);
  }
});

test("endRun 抛错也不影响 completion settle 与终态事件", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { factory } = fakeFactory(async function* () {
    yield resultMessage("ok", "r1", "s");
  });
  const gate: ActivityGate = {
    isIdle: () => true,
    beginRun: () => undefined,
    endRun: () => { throw new Error("tracker glitch"); },
  };
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.deepEqual(await handle.completion, { state: "done" });
  const events = await collect(handle.events);
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "done" });
});

test("clientMessageId 透传为 SDK 输入消息 uuid；省略时不设置", async () => {
  const clientMessageId = "11111111-1111-4111-8111-111111111111";
  const first = fakeFactory(async function* () {
    yield resultMessage("ok", "r1", "sess-cm");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: first.factory });
  const handle = runner.startTurn({ sessionId: "sess-cm", cwd: "/tmp", text: "hi", clientMessageId });
  await handle.completion;

  const input = first.state.params?.prompt as AsyncIterable<{ uuid?: string }>;
  const sent = await input[Symbol.asyncIterator]().next();
  assert.equal(sent.value.uuid, clientMessageId);

  const second = fakeFactory(async function* () {
    yield resultMessage("ok", "r2", "sess-nocm");
  });
  const runner2 = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: second.factory });
  await runner2.startTurn({ sessionId: "sess-nocm", cwd: "/tmp", text: "hi" }).completion;

  const input2 = second.state.params?.prompt as AsyncIterable<{ uuid?: string }>;
  const sent2 = await input2[Symbol.asyncIterator]().next();
  assert.equal(Object.hasOwn(sent2.value, "uuid"), false);
});

test("stream：delta 携带 apiMessageId/blockIndex，snapshot 按块拼接文本", async () => {
  const release = deferred();
  const { factory } = fakeFactory(async function* () {
    yield streamEvent("u1", "sess-stream", { type: "message_start", message: { id: "msg_A" } });
    yield streamEvent("u1", "sess-stream", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield streamEvent("u1", "sess-stream", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
    yield streamEvent("u1", "sess-stream", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
    await release.promise;
    yield resultMessage("完成", "r1", "sess-stream");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-stream", cwd: "/tmp", text: "hi" });
  const iterator = handle.events[Symbol.asyncIterator]();

  const deltas = await nextDeltas(iterator, 2);
  assert.deepEqual(deltas, [
    { type: "assistant_delta", text: "Hel", messageId: "u1", apiMessageId: "msg_A", blockIndex: 0 },
    { type: "assistant_delta", text: "lo", messageId: "u1", apiMessageId: "msg_A", blockIndex: 0 },
  ]);
  assert.deepEqual(runner.streamSnapshot("sess-stream"), [{ messageId: "msg_A", blockIndex: 0, text: "Hello" }]);

  release.resolve();
  assert.deepEqual(await handle.completion, { state: "done" });
});

test("stream：blockIndex 递增形成独立 snapshot 条目", async () => {
  const release = deferred();
  const { factory } = fakeFactory(async function* () {
    yield streamEvent("u2", "sess-blocks", { type: "message_start", message: { id: "msg_B" } });
    yield streamEvent("u2", "sess-blocks", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield streamEvent("u2", "sess-blocks", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第一块" } });
    yield streamEvent("u2", "sess-blocks", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    yield streamEvent("u2", "sess-blocks", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "第二块" } });
    await release.promise;
    yield resultMessage("完成", "r1", "sess-blocks");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-blocks", cwd: "/tmp", text: "hi" });
  const iterator = handle.events[Symbol.asyncIterator]();

  await nextDeltas(iterator, 2);
  assert.deepEqual(runner.streamSnapshot("sess-blocks"), [
    { messageId: "msg_B", blockIndex: 0, text: "第一块" },
    { messageId: "msg_B", blockIndex: 1, text: "第二块" },
  ]);

  release.resolve();
  assert.deepEqual(await handle.completion, { state: "done" });
});

test("stream snapshot：run 结束后与未知会话均返回 undefined", async () => {
  const { factory } = fakeFactory(async function* () {
    yield streamEvent("u3", "sess-settled", { type: "message_start", message: { id: "msg_C" } });
    yield streamEvent("u3", "sess-settled", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield streamEvent("u3", "sess-settled", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
    yield resultMessage("完成", "r1", "sess-settled");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-settled", cwd: "/tmp", text: "hi" });

  assert.deepEqual(await handle.completion, { state: "done" });
  assert.equal(runner.streamSnapshot("sess-settled"), undefined);
  assert.equal(runner.streamSnapshot("unknown-session"), undefined);
});

test("stream buffer 超过 32768：先删最旧块，单块仍超长则从头裁剪", async () => {
  const release = deferred();
  const { factory } = fakeFactory(async function* () {
    yield streamEvent("u4", "sess-bound", { type: "message_start", message: { id: "msg_D" } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a".repeat(17000) } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "b".repeat(17000) } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    yield streamEvent("u4", "sess-bound", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "c".repeat(10000) } });
    await release.promise;
    yield resultMessage("完成", "r1", "sess-bound");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "sess-bound", cwd: "/tmp", text: "hi" });
  await nextDeltas(handle.events[Symbol.asyncIterator](), 3);

  const snapshot = runner.streamSnapshot("sess-bound");
  assert.deepEqual(snapshot, [
    { messageId: "msg_D", blockIndex: 1, text: "b".repeat(17000) },
    { messageId: "msg_D", blockIndex: 2, text: "c".repeat(10000) },
  ]);
  assert.ok(snapshot !== undefined && snapshot.reduce((sum, block) => sum + block.text.length, 0) <= 32768);

  release.resolve();
  assert.deepEqual(await handle.completion, { state: "done" });

  const releaseSingle = deferred();
  const single = fakeFactory(async function* () {
    yield streamEvent("u5", "sess-slice", { type: "message_start", message: { id: "msg_E" } });
    yield streamEvent("u5", "sess-slice", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield streamEvent("u5", "sess-slice", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a".repeat(1000) + "b".repeat(39000) } });
    await releaseSingle.promise;
    yield resultMessage("完成", "r2", "sess-slice");
  });
  const runner2 = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: single.factory });
  const handle2 = runner2.startTurn({ sessionId: "sess-slice", cwd: "/tmp", text: "hi" });
  await nextDeltas(handle2.events[Symbol.asyncIterator](), 1);

  assert.deepEqual(runner2.streamSnapshot("sess-slice"), [
    { messageId: "msg_E", blockIndex: 0, text: "b".repeat(32768) },
  ]);

  releaseSingle.resolve();
  assert.deepEqual(await handle2.completion, { state: "done" });
});
