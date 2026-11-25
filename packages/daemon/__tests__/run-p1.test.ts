import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { fakeP1Sdk } from "./fixtures/p1-sdk.js";
import { NotIdleError, RunRequestError, TurnRunner, type RunEvent } from "../src/run/runner.js";

const sessionId = "ac8105be-9920-4b13-9338-616ee270caed";
const otherId = "e5ff9192-871f-42c4-8cac-3a05b8532997";
const cwd = "/tmp";

function harness() {
  const sdk = fakeP1Sdk();
  const terminal = new Set<string>();
  const runner = new TurnRunner({ queryFactory: sdk.factory, abortGraceMs: 10,
    gate: { isIdle: (id) => !terminal.has(id), beginRun: () => {}, endRun: () => {} },
    permissions: { request: async () => ({ type: "deny" }) },
  });
  return { runner, queries: sdk.queries, terminal };
}

test("extension reloads serialize across timeout and discard old Query responses after send-now", { timeout: 9000 }, async () => {
  const { runner, queries } = harness();
  const handle = runner.startTurn({ sessionId, cwd, text: "initial" });
  const [first] = queries;
  assert.ok(first);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const snapshot = { plugins: [{ name: "loaded", path: "/private" }], mcpServers: [], commands: first.commands, agents: [], error_count: 0 };
  first.reloadPlugins = async () => { await wait; return snapshot; };
  const reload = () => runner.extensions(sessionId, { type: "reload" }, handle.runId);
  const pending = reload();
  assert.deepEqual(await reload(), { status: "unavailable", reason: "extension_busy" });
  assert.deepEqual(await pending, { status: "unavailable", reason: "sdk_unavailable" });
  assert.deepEqual(await reload(), { status: "unavailable", reason: "extension_busy" });
  release();
  await setImmediate();
  assert.equal(runner.p1State(sessionId).commands, undefined);
  assert.deepEqual(await runner.extensions(sessionId, { type: "read" }), { status: "unavailable", reason: "sdk_unavailable" });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => { finish = resolve; });
  first.reloadPlugins = async () => { await finishing; return snapshot; };
  const stale = reload();
  await setImmediate();
  const replacement = randomUUID();
  runner.steer(sessionId, handle.runId, replacement, "replacement");
  runner.mutateSteer(sessionId, handle.runId, replacement, { type: "send_now" });
  await setImmediate();
  const second = queries[1];
  assert.ok(second);
  finish();
  assert.deepEqual(await stale, { status: "unavailable", reason: "session_changed" });
  assert.deepEqual(await runner.extensions(sessionId, { type: "read" }), { status: "unavailable", reason: "initializing" });
  second.reloadPlugins = async () => snapshot;
  assert.deepEqual(await reload(), await reload());
  second.send({ type: "system", subtype: "commands_changed", commands: snapshot.commands });
  second.result(replacement);
  await handle.completion;
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  assert.equal(events.filter((e) => e.type === "commands").length, 1);
});

test("P1 steer serializes inputs, confirms delivery, and never counts replayed result frames twice", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  const handle = runner.startTurn({ sessionId, cwd, text: "start", clientMessageId: first });
  const query = queries[0]!;
  const events = (async () => {
    const frames: RunEvent[] = [];
    for await (const frame of handle.events) frames.push(frame);
    return frames;
  })();
  assert.deepEqual((await query.input()).uuid, first);
  assert.deepEqual(query.params.options?.extraArgs, { "replay-user-messages": null });
  query.init();
  assert.equal(runner.steer(sessionId, handle.runId, second, "more").receipt.state, "queued");
  assert.equal(runner.steer(sessionId, handle.runId, second, "duplicate").replayed, true);
  assert.equal(runner.steer(sessionId, handle.runId, third, "last").receipt.state, "queued");
  assert.throws(() => runner.steer(otherId, handle.runId, second, "wrong session"), { code: "not_idle" });
  assert.throws(() => runner.steer(sessionId, randomUUID(), randomUUID(), "wrong run"), { code: "run_mismatch" });
  assert.throws(() => runner.steer(sessionId, handle.runId, first, "initial collision"), { code: "message_id_conflict" });

  const queued = query.input();
  assert.equal(await Promise.race([queued.then(() => true), setImmediate(false)]), false);
  query.result(first);
  const followup = await queued;
  assert.equal(followup.uuid, second);
  assert.equal(followup.message.content, "more");
  query.result(first);
  query.send({ type: "user", uuid: second, isReplay: true, message: { role: "user", content: "more" } });
  await setImmediate();
  assert.equal(runner.steerReceipt(sessionId, second)?.state, "delivered");
  query.result(second, { tokens: 4, total: 0.06 });
  assert.equal((await query.input()).uuid, third);
  query.result(third, { tokens: 5, total: 0.07 });
  assert.deepEqual(await handle.completion, { state: "done" });

  const frames = await events;
  const usage = frames.filter((frame) => frame.type === "usage").map(({ turn }) => turn);
  assert.deepEqual(usage.map((item) => [item.clientMessageId, item.turnIndex, item.usage?.input_tokens]), [
    [first, 1, 3], [second, 2, 4], [third, 3, 5],
  ]);
  assert.deepEqual(usage.map((item) => item.sdkTotals?.total_cost_usd), [0.04, 0.06, 0.07]);
  assert.equal(usage[2]?.sdkTotals?.scope, "session");
  assert.deepEqual(usage[2]?.turnModelUsage, { fixture: { inputTokens: 5 } });
  assert.deepEqual(frames.filter((frame) => frame.type === "steer").filter((frame) => frame.receipt.clientMessageId === second)
    .map(({ receipt }) => [receipt.state, receipt.revision]), [["queued", 1], ["delivered", 2], ["processed", 3]]);
  assert.equal(runner.p1State(sessionId).latestTurn?.clientMessageId, third);
  assert.equal(runner.steer(sessionId, handle.runId, second, "retry").receipt.state, "processed");
  assert.equal(query.closed, true);
});

test("P1 abort cancels both handed-off and pending supplements and stream failure fails unprocessed IDs", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const failed = randomUUID(), delivered = randomUUID(), queued = randomUUID();
  const handle = runner.startTurn({ sessionId, cwd, text: "start", clientMessageId: randomUUID() });
  const query = queries[0]!;
  const start = await query.input();
  runner.steer(sessionId, handle.runId, delivered, "first");
  runner.steer(sessionId, handle.runId, queued, "second");
  query.result(start.uuid);
  assert.equal((await query.input()).uuid, delivered);
  query.send({ type: "user", isReplay: true, uuid: delivered, message: { role: "user", content: "first" } });
  await setImmediate();
  assert.equal(runner.steerReceipt(sessionId, delivered)?.state, "delivered");
  assert.equal(runner.abort(handle.runId), true);
  assert.throws(() => runner.steer(sessionId, handle.runId, randomUUID(), "late"), RunRequestError);
  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });
  assert.deepEqual(runner.p1State(sessionId).steering?.map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.equal(query.interrupts, 1);

  const next = runner.startTurn({ sessionId, cwd, text: "again", clientMessageId: randomUUID() });
  const secondQuery = queries[1]!;
  const message = await secondQuery.input();
  runner.steer(sessionId, next.runId, failed, "pending");
  secondQuery.result(message.uuid, { error: "auth denied" });
  assert.deepEqual(await next.completion, { state: "error", error: "auth denied" });
  assert.equal(runner.steerReceipt(sessionId, failed)?.state, "failed");
});

test("P1 discovery runs without a user prompt or persisted session and context is gated", { timeout: 4000 }, async () => {
  const { runner, queries, terminal } = harness();
  const commands = await runner.commands(cwd);
  assert.deepEqual(commands?.commands.map(({ name, kind, availability }) => [name, kind, availability]), [
    ["compact", "command", "available"], ["context", "command", "available"],
    ["review", "skill", "available"], ["other", "unknown", "unverified"],
  ]);
  assert.equal(queries[0]?.params.options?.persistSession, false);
  assert.equal(queries[0]?.closed, true);
  assert.deepEqual(await runner.context(sessionId), { status: "unavailable", reason: "no_active_sdk" });

  terminal.add(sessionId);
  assert.equal(await runner.commands(cwd, sessionId), undefined);
  assert.throws(() => runner.startTurn({ sessionId, cwd, text: "/compact", compact: { clientMessageId: randomUUID() } }), NotIdleError);
  assert.equal(queries.length, 1);
});

test("P1 compaction requires native evidence and handles unsupported, no-op, failed, and successful results", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  for (const [index, outcome] of ["not_needed", "success", "failed", "unavailable", "missing_signal"].entries()) {
    const id = randomUUID();
    const handle = runner.startTurn({ sessionId, cwd, text: "/compact retain decisions", compact: { clientMessageId: id } });
    const query = queries[index]!;
    if (outcome === "unavailable") query.commands = [];
    else {
      assert.deepEqual(await query.input(), { type: "user", uuid: id, message: { role: "user", content: "/compact retain decisions" },
        parent_tool_use_id: null, origin: { kind: "human" } });
      assert.equal(runner.compactReceipt(sessionId, id)?.state, "compacting");
      if (outcome === "not_needed") query.send({ type: "system", subtype: "local_command_output",
        uuid: "noop", content: "<local-command-stderr>Error: No messages to compact</local-command-stderr>" });
      if (outcome === "failed") query.send({ type: "system", subtype: "status", uuid: "failed", compact_result: "failed", compact_error: "gateway offline" });
      if (outcome === "success") query.send({ type: "system", subtype: "compact_boundary", uuid: "boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 123, post_tokens: 30 } });
      query.result(id);
    }
    await handle.completion;
    const receipt = runner.compactReceipt(sessionId, id);
    assert.equal(receipt?.state, outcome === "unavailable" || outcome === "missing_signal" ? "failed" : outcome);
    if (outcome === "success") assert.equal(receipt?.boundary?.metadata.post_tokens, 30);
    if (outcome === "unavailable") assert.equal(receipt?.error, "compact_unavailable");
    if (outcome === "missing_signal") assert.equal(receipt?.error, "compact_outcome_unavailable");
  }
});

test("P1 bounds queued messages and reports a stream ending without a result", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const handle = runner.startTurn({ sessionId, cwd, text: "start" });
  const ids = Array.from({ length: 16 }, () => randomUUID());
  for (const id of ids) runner.steer(sessionId, handle.runId, id, "queued");
  assert.throws(() => runner.steer(sessionId, handle.runId, randomUUID(), "overflow"), { code: "queue_full" });
  assert.equal(runner.steer(sessionId, handle.runId, ids[0]!, "retry").replayed, true);
  queries[0]?.close();
  assert.deepEqual(await handle.completion, { state: "error", error: "sdk_ended_without_result" });
  assert.equal(runner.p1State(sessionId).steering?.filter(({ state }) => state === "failed").length, 16);
});

test("P1 queued receipts keep edited text and deleted inputs never reach the SDK", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const handle = runner.startTurn({ sessionId, cwd, text: "initial", clientMessageId: randomUUID() });
  const query = queries[0]!;
  const initial = await query.input();
  const changed = randomUUID(), removed = randomUUID();
  runner.steer(sessionId, handle.runId, changed, "old text");
  runner.steer(sessionId, handle.runId, removed, "remove me");
  assert.deepEqual(runner.mutateSteer(sessionId, handle.runId, changed, { type: "edit", text: "new text" }), {
    runId: handle.runId, clientMessageId: changed, text: "new text", state: "queued", revision: 2,
  });
  assert.deepEqual(runner.mutateSteer(sessionId, undefined, removed, { type: "cancel" }), {
    runId: handle.runId, clientMessageId: removed, text: "remove me", state: "cancelled", revision: 2,
  });
  assert.throws(() => runner.mutateSteer(sessionId, randomUUID(), changed, { type: "cancel" }), { code: "run_mismatch" });
  assert.throws(() => runner.mutateSteer(otherId, handle.runId, changed, { type: "send_now" }), { code: "steer_not_found" });
  assert.equal(runner.steer(sessionId, handle.runId, changed, "stale retry").receipt.text, "new text");
  query.result(initial.uuid);
  assert.deepEqual((await query.input()).message, { role: "user", content: "new text" });
  assert.throws(() => runner.mutateSteer(sessionId, handle.runId, changed, { type: "edit", text: "too late" }),
    { code: "steer_not_editable", state: "delivered" });
  assert.throws(() => runner.mutateSteer(sessionId, handle.runId, changed, { type: "cancel" }),
    { code: "steer_not_cancellable", state: "delivered" });
  assert.throws(() => runner.mutateSteer(sessionId, handle.runId, changed, { type: "send_now" }),
    { code: "steer_not_sendable", state: "delivered" });
  query.result(changed);
  assert.deepEqual(await handle.completion, { state: "done" });
  assert.equal(runner.steerReceipt(sessionId, changed)?.state, "processed");
});

test("P1 send-now handles both interruption results and dead streams, keeps run identity and drains the other inputs", { timeout: 4000 }, async () => {
  for (const mode of ["result", "eof", "timeout"]) {
    const { runner, queries } = harness();
    const handle = runner.startTurn({ sessionId, cwd, text: "initial", clientMessageId: randomUUID(),
      model: "fixture-model", effort: "high", permissionMode: "plan" });
    const query = queries[0]!;
    const { uuid } = await query.input();
    const first = randomUUID(), now = randomUUID(), third = randomUUID();
    runner.steer(sessionId, handle.runId, first, "first");
    runner.steer(sessionId, handle.runId, now, "send now");
    runner.steer(sessionId, handle.runId, third, "third");
    query.onInterrupt = () => {
      if (mode === "result") query.result(uuid, { error: "interrupted" });
      if (mode === "eof") query.close();
    };
    const priority = runner.mutateSteer(sessionId, handle.runId, now, { type: "send_now" });
    assert.equal(priority.revision, 2);
    assert.deepEqual(runner.mutateSteer(sessionId, handle.runId, now, { type: "send_now" }), priority);
    assert.equal(query.interrupts, 1);
    assert.equal(runner.steerReceipt(sessionId, first)?.state, "queued");
    for (let tries = 0; queries.length < 2 && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const resumed = queries[1];
    assert.ok(resumed, mode);
    assert.equal(query.closed, true);
    assert.equal(runner.activeRunId(sessionId), handle.runId);
    assert.equal(resumed.params.options?.resume, sessionId);
    assert.equal(resumed.params.options?.model, "fixture-model");
    assert.equal(resumed.params.options?.effort, "high");
    assert.equal(resumed.params.options?.permissionMode, "plan");
    assert.equal((await resumed.input()).uuid, now);
    assert.equal(runner.steerReceipt(sessionId, now)?.state, "delivered");
    resumed.result(now);
    assert.equal((await resumed.input()).uuid, first);
    resumed.result(first);
    assert.equal((await resumed.input()).uuid, third);
    resumed.result(third);
    assert.deepEqual(await handle.completion, { state: "done" });
    for (const id of [first, now, third]) assert.equal(runner.steerReceipt(sessionId, id)?.state, "processed");
  }
});

test("P1 abort during send-now cleanup cancels the queue before a replacement Query can start", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const handle = runner.startTurn({ sessionId, cwd, text: "initial" });
  const query = queries[0]!;
  const now = randomUUID(), later = randomUUID();
  runner.steer(sessionId, handle.runId, now, "priority");
  runner.steer(sessionId, handle.runId, later, "later");
  let release!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => { entered = resolve; });
  query.onReturn = async () => { entered(); await cleanupGate; };
  runner.mutateSteer(sessionId, handle.runId, now, { type: "send_now" });
  await cleanupEntered;
  assert.equal(runner.abort(handle.runId), true);
  release();
  assert.deepEqual(await handle.completion, { state: "error", error: "aborted" });
  assert.equal(queries.length, 1);
  assert.equal(runner.steerReceipt(sessionId, now)?.state, "cancelled");
  assert.equal(runner.steerReceipt(sessionId, later)?.state, "cancelled");
});

test("P1 cancelling a side chat closes its SDK and frees the per-session slot", { timeout: 4000 }, async () => {
  const { runner, queries } = harness();
  const controller = new AbortController();
  const pending = runner.sideChat(cwd, sessionId, "temporary", undefined, controller.signal);
  const query = queries[0]!;
  await query.input();
  assert.equal(await runner.sideChat(cwd, sessionId, "overflow", undefined, new AbortController().signal), undefined);
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(query.closed, true);
  assert.equal(runner.activeRunId(sessionId), undefined);
  const next = runner.sideChat(cwd, sessionId, "second", undefined, new AbortController().signal);
  const restarted = queries[1]!;
  restarted.result(randomUUID(), { result: "answer" });
  assert.equal((await next)?.answer, "answer");
});

test("plain SDK EOF and cancelling the sole send-now input both end with errors", async () => {
  const { runner, queries } = harness();
  const initial = runner.startTurn({ sessionId, cwd, text: "initial" });
  queries[0]!.close();
  assert.deepEqual(await initial.completion, { state: "error", error: "sdk_ended_without_result" });

  const handle = runner.startTurn({ sessionId, cwd, text: "second" });
  const id = randomUUID();
  runner.steer(sessionId, handle.runId, id, "priority");
  runner.mutateSteer(sessionId, handle.runId, id, { type: "send_now" });
  runner.mutateSteer(sessionId, handle.runId, id, { type: "cancel" });
  queries[1]!.close();
  assert.deepEqual(await handle.completion, { state: "error", error: "interrupted" });
  assert.equal(queries.length, 2);
  assert.equal(runner.steerReceipt(sessionId, id)?.state, "cancelled");
});

test("stuck /btw cleanup has its own deadline and frees the slot even after a client abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runner, queries } = harness();
  const stop = new AbortController();
  const reply = runner.sideChat(cwd, sessionId, "temporary", undefined, stop.signal);
  const query = queries[0]!;
  await query.input();
  let enterCleanup!: () => void;
  const entered = new Promise<void>((resolve) => { enterCleanup = resolve; });
  query.onReturn = () => {
    enterCleanup();
    return new Promise(() => {});
  };
  stop.abort();
  await entered;
  t.mock.timers.tick(5000);
  assert.equal(await reply, undefined);
  const next = runner.sideChat(cwd, sessionId, "next", undefined, new AbortController().signal);
  queries[1]!.result(randomUUID(), { result: "answer" });
  assert.equal((await next)?.answer, "answer");
});
