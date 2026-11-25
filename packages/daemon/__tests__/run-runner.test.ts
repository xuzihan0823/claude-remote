// TurnRunner：事件流、互斥、abort、completion 不逃逸。全部走 fake QueryFactory，不碰真 SDK。

import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";

import { adaptSdkMessage, type PermissionBroker, type QueryFactory } from "@claude-remote/agent-bridge";
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
  stopTask?: (taskId: string) => Promise<void>,
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
    if (stopTask) augmented.stopTask = stopTask;
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
    yield resultMessage("ok", "r1", "s");
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
  const { factory } = fakeFactory(async function* (state) {
    const id = state.params?.options?.resume;
    await new Promise<void>((resolve) => releases.push(resolve));
    if (id !== undefined) yield resultMessage("ok", "r1", id);
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

test("abort 后 interrupt 不生效（CLI 卡死）：宽限期满强制 close，run 仍以 aborted 收尾", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { factory, state } = fakeFactory(async function* () {
    yield assistantMessage("卡住前", "m1", "s");
    await new Promise<void>(() => undefined); // 永不返回，interrupt 也不理
  });
  const { gate, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory, abortGraceMs: 30 });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.abort(handle.runId), true);
  assert.equal(runner.abort(handle.runId), true); // 重复停止幂等，不重复挂计时器
  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });
  assert.equal(state.interrupts, 1);
  assert.ok(state.closes >= 1);
  assert.deepEqual(ended, ["s"]);
  assert.equal(runner.activeRunId("s"), undefined);
  // 会话已解锁，可以再发
  assert.doesNotThrow(() => runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "again" }));
});

test("result is_error（模型不可用/鉴权失败）：run 以 error 收尾并带上错误文本", async () => {
  const { factory } = fakeFactory(async function* () {
    yield assistantMessage("API Error: 404 model not found", "m1", "s");
    yield sdkMessage({ type: "result", subtype: "success", is_error: true, result: "API Error: 404 model not found", uuid: "r1", session_id: "s" });
  });
  const { gate, ended } = stubGate();
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "s", cwd: "/tmp", text: "hi" });
  assert.deepEqual(await handle.completion, { state: "error", error: "API Error: 404 model not found" });
  const events = await collect(handle.events);
  assert.deepEqual(events.at(-1), { type: "run", runId: handle.runId, sessionId: "s", state: "error", error: "API Error: 404 model not found" });
  assert.deepEqual(ended, ["s"]);
});

test("active auto state remains unconfirmed until SDK reports it; diagnostics are bounded and cleared", async () => {
  const release = deferred();
  const ready = deferred();
  let approvals = 0;
  const { factory, state } = fakeFactory(async function* () {
    yield sdkMessage({ type: "system", subtype: "init", session_id: "other", permissionMode: "bypassPermissions" });
    yield sdkMessage({ type: "system", subtype: "status", session_id: "auto-session" });
    yield sdkMessage({ type: "system", subtype: "init", session_id: "auto-session", permissionMode: "auto" });
    yield sdkMessage({ type: "system", subtype: "status", session_id: "auto-session", permissionMode: "future-mode" });
    for (let i = 0; i < 105; i++) yield sdkMessage({ type: "system", subtype: "permission_denied", session_id: "auto-session", uuid: `deny-${i}`, tool_use_id: `tu-${i}`, tool_name: "Bash", message: "Denied" });
    ready.resolve();
    await release.promise;
    yield resultMessage("continued after denial", "result", "auto-session");
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: { request: async () => { approvals++; return { type: "deny" }; } }, queryFactory: factory });
  const handle = runner.startTurn({ sessionId: "auto-session", cwd: "/tmp", text: "go", permissionMode: "auto" });
  assert.deepEqual(runner.activeState("auto-session"), { activeRunId: handle.runId, requestedPermissionMode: "auto" });
  await ready.promise;
  assert.equal(state.params?.options?.permissionMode, "auto");
  assert.deepEqual(runner.activeState("auto-session"), { activeRunId: handle.runId, requestedPermissionMode: "auto", effectivePermissionMode: "future-mode" });
  assert.equal(runner.activeDiagnostics("auto-session").length, 100);
  assert.equal(approvals, 0);
  release.resolve();
  assert.deepEqual(await handle.completion, { state: "done" });
  assert.equal(runner.activeState("auto-session"), undefined);
  assert.deepEqual(runner.activeDiagnostics("auto-session"), []);
});

function taskMessage(sessionId: string, subtype: string, uuid: string, fields: Record<string, unknown>): AnySdkMessage {
  return sdkMessage({ type: "system", session_id: sessionId, subtype, uuid, ...fields });
}

test("tasks reconcile full background sets and retain terminal states across out-of-order edges", { timeout: 4000 }, async (t) => {
  const session = "task-session";
  const ready = deferred();
  const finish = deferred();
  const level = (uuid: string, ...ids: string[]) => taskMessage(session, "background_tasks_changed", uuid, {
    tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", description: `Build ${task_id}` })),
  });
  const edge = (subtype: string, uuid: string, task_id: string, fields: Record<string, unknown> = {}) =>
    taskMessage(session, subtype, uuid, { task_id, ...fields });
  const progress = edge("task_progress", "p1", "foreground", { description: "Working", summary: "Newest", usage: { total_tokens: 42, tool_uses: 2, duration_ms: 500 } });
  const { factory } = fakeFactory(async function* () {
    yield edge("task_notification", "n1", "early", { status: "completed", summary: "Finished" });
    yield sdkMessage({ ...assistantMessage("bounded child output", "child-1", session), parent_tool_use_id: "tool-a" });
    yield sdkMessage({ ...assistantMessage("bounded child output", "child-1", session), parent_tool_use_id: "tool-a" });
    yield edge("task_started", "s1", "early", { task_type: "local_agent", tool_use_id: "tool-a", description: "Review" });
    yield edge("task_notification", "n2", "terminal-only", { status: "failed" });
    yield progress;
    yield progress;
    yield edge("task_progress", "p2", "foreground", { description: "Older", summary: "Stale", usage: { total_tokens: 1, tool_uses: 0, duration_ms: 100 } });
    yield level("level-1", "early", "removed", "missed", "stays");
    yield level("level-2", "stays");
    yield level("level-1", "early", "removed", "missed", "stays");
    yield edge("task_started", "s2", "removed", { task_type: "local_bash", tool_use_id: "tool-shell" });
    yield edge("task_notification", "n3", "removed", { status: "completed", summary: "Built" });
    ready.resolve();
    await finish.promise;
    yield resultMessage("done", "result", session);
  });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const run = runner.startTurn({ sessionId: session, cwd: "/tmp", text: "run tasks" });
  await ready.promise;
  const byId = (id: string) => runner.tasks(session).find((task) => task.taskId === id);
  assert.equal(byId("early")?.status, "completed");
  assert.equal(byId("early")?.output, "bounded child output");
  assert.equal(byId("early")?.toolUseId, "tool-a");
  assert.equal(byId("terminal-only")?.status, "failed");
  assert.equal(byId("foreground")?.status, "running");
  assert.equal(byId("foreground")?.summary, "Newest");
  assert.equal(byId("removed")?.status, "completed");
  assert.equal(byId("removed")?.endReason, undefined);
  assert.equal(byId("missed")?.endReason, "background_inactive");
  assert.equal(byId("stays")?.status, "running");

  finish.resolve();
  const events = (await collect(run.events)).filter((event) => event.type === "task");
  assert.deepEqual(await run.completion, { state: "done" });
  assert.equal(events.filter(({ task }) => task.eventId === "p1").length, 1);
  assert.deepEqual(events.filter(({ task }) => task.taskId === "removed").map(({ task }) => task.status), ["running", "stopped", "stopped", "completed"]);
  assert.deepEqual(events.filter(({ task }) => task.taskId === "stays").map(({ task }) => task.revision), [1, 2]);
  assert.equal(byId("foreground")?.endReason, "run_ended");
  assert.equal(byId("foreground")?.status, "stopped");
  assert.equal((await runner.stopTask(session, "removed", run.runId)).status, "completed");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(600_001);
  assert.deepEqual(runner.tasks(session), []);
  await assert.rejects(runner.stopTask(session, "removed", run.runId), { code: "no_active_run" });
});

test("task stop coalesces pending control and preserves a terminal notification that arrives first", { timeout: 4000 }, async () => {
  const session = "task-stop-race";
  const ready = deferred();
  const stopped = deferred();
  const ack = deferred();
  const finish = deferred();
  const calls: string[] = [];
  const { factory } = fakeFactory(async function* () {
    yield taskMessage(session, "task_started", "s1", { task_id: "agent-1", description: "Review" });
    ready.resolve();
    await stopped.promise;
    yield taskMessage(session, "task_notification", "n1", { task_id: "agent-1", status: "completed" });
    ack.resolve();
    await finish.promise;
    throw new Error("SDK failed");
  }, async (id) => { calls.push(id); stopped.resolve(); await ack.promise; });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const run = runner.startTurn({ sessionId: session, cwd: "/tmp", text: "start" });
  await ready.promise;
  const first = runner.stopTask(session, "agent-1", run.runId);
  const second = runner.stopTask(session, "agent-1", run.runId);
  for (const receipt of await Promise.all([first, second])) {
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.eventId, "n1");
    assert.equal(receipt.stopRequested, undefined);
  }
  assert.deepEqual(calls, ["agent-1"]);
  finish.resolve();
  assert.deepEqual(await run.completion, { state: "error", error: "SDK failed" });
  assert.equal(runner.tasks(session)[0]?.status, "completed");
});

test("unsettled tasks become failed or stopped when a run fails or is aborted", async () => {
  for (const aborted of [false, true]) {
    const session = "unsettled-tasks";
    const ready = deferred();
    const finish = deferred();
    const { factory, state } = fakeFactory(async function* () {
      yield taskMessage(session, "task_started", "s1", { task_id: "agent-1", description: "Still working" });
      ready.resolve();
      await finish.promise;
      throw new Error("SDK failed");
    });
    const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
    const run = runner.startTurn({ sessionId: session, cwd: "/tmp", text: "start" });
    state.onInterrupt = finish.resolve;
    await ready.promise;
    if (aborted) assert.equal(runner.abort(run.runId), true);
    else finish.resolve();
    assert.equal((await run.completion).state, "error");
    assert.equal(runner.tasks(session)[0]?.status, aborted ? "stopped" : "failed");
    assert.equal(runner.tasks(session)[0]?.endReason, aborted ? "run_aborted" : "run_failed");
  }
});

test("replacing a Query settles its tasks and fences a delayed stop acknowledgement", { timeout: 4000 }, async () => {
  const session = "task-query-switch";
  const firstReady = deferred();
  const firstDone = deferred();
  const secondReady = deferred();
  const secondDone = deferred();
  const controlStarted = deferred();
  const controlAck = deferred();
  let opened = 0;
  const calls: string[] = [];
  const background = (uuid: string, task_id: string) => taskMessage(session, "background_tasks_changed", uuid, {
    tasks: [{ task_id, task_type: "local_agent", description: "Review" }],
  });
  const { factory, state } = fakeFactory(async function* () {
    if (++opened === 1) {
      yield background("old-level", "old-agent");
      firstReady.resolve();
      await firstDone.promise;
      return;
    }
    yield background("new-level", "new-agent");
    secondReady.resolve();
    await secondDone.promise;
    yield resultMessage("done", "result", session);
  }, async (id) => { calls.push(id); controlStarted.resolve(); await controlAck.promise; });
  const runner = new TurnRunner({ gate: stubGate().gate, permissions: denyAll, queryFactory: factory });
  const run = runner.startTurn({ sessionId: session, cwd: "/tmp", text: "start" });
  state.onInterrupt = firstDone.resolve;
  await firstReady.promise;
  const stop = runner.stopTask(session, "old-agent", run.runId).then(
    (task) => { assert.equal(task.status, "stopped"); },
    (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, "run_stopping"); },
  );
  await controlStarted.promise;
  const clientId = "aaaabbbb-2222-4444-9999-aaaabbbbcccc";
  runner.steer(session, run.runId, clientId, "Next input");
  runner.mutateSteer(session, run.runId, clientId, { type: "send_now" });
  await secondReady.promise;
  controlAck.resolve();
  await stop;
  const oldTask = await runner.stopTask(session, "old-agent", run.runId);
  assert.equal(oldTask.endReason, "query_interrupted");
  assert.equal(oldTask.stopRequested, undefined);
  assert.equal(runner.tasks(session).find((task) => task.taskId === "new-agent")?.status, "running");
  assert.deepEqual(calls, ["old-agent"]);
  secondDone.resolve();
  assert.deepEqual(await run.completion, { state: "done" });
});

test("rewind reserves the turn lock through SDK shutdown, including UUID case variants", async () => {
  const { gate, begun, ended } = stubGate();
  const closing = deferred();
  const release = deferred();
  const calls: Array<boolean | undefined> = [];
  const factory: QueryFactory = () => {
    const generator = (async function* () {})();
    return Object.assign(generator, {
      rewindFiles: async (_id: string, options?: { dryRun?: boolean }) => {
        calls.push(options?.dryRun);
        return { canRewind: true };
      },
      return: async () => {
        closing.resolve();
        await release.promise;
        return { done: true, value: undefined };
      },
    }) as unknown as SdkQuery;
  };
  const runner = new TurnRunner({ gate, permissions: denyAll, queryFactory: factory });
  const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const options = {
    sessionId, cwd: "/tmp/project", file: "/tmp/projects/session.jsonl", dryRun: false,
    userMessageId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", signal: new AbortController().signal,
    isCliAlive: async () => false,
  };
  const pending = runner.rewindFiles(options);
  await closing.promise;
  try {
    assert.deepEqual(calls, [true, false]);
    assert.equal(runner.activeRunId(sessionId), undefined);
    assert.throws(() => runner.startTurn({ ...options, sessionId: sessionId.toUpperCase(), text: "continue" }), NotIdleError);
    await assert.rejects(runner.rewindFiles(options), NotIdleError);
    assert.deepEqual(ended, []);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await pending, { result: { canRewind: true } });
  assert.deepEqual(begun, [sessionId]);
  assert.deepEqual(ended, [sessionId]);
  const terminal = await runner.rewindFiles({ ...options, isCliAlive: async () => true });
  assert.deepEqual(terminal, { error: "terminal_driving" });
  assert.deepEqual(calls, [true, false, true]);
});
