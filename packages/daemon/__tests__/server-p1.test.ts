import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

import { InteractionManager, InteractionStore } from "@claude-remote/interactions";
import { startRelay } from "@claude-remote/relay";
import { deriveDeviceId, encodeControl, generateDeviceKey, parseControl } from "@claude-remote/relay/protocol";
import { DaemonServer, type DaemonServerOptions } from "../src/server.js";
import { RelayConnector } from "../src/relay/connector.js";
import { ApprovalBridge } from "../src/run/approval.js";
import { TurnRunner } from "../src/run/runner.js";
import { ActivityTracker } from "../src/watch/activity.js";
import { SessionWatcher } from "../src/watch/watcher.js";
import { memoryHttp } from "./fixtures/memory-http.js";
import { fakeP1Sdk } from "./fixtures/p1-sdk.js";

const runGit = promisify(execFile);
const TOKEN = "p1-fixture-token";
const ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER = "22222222-bbbb-4bbb-8bbb-222222222222";
const route = (name: string, session = ID) => `/api/sessions/${session}/${name}`;
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");

async function harness(t: TestContext, options: Pick<DaemonServerOptions, "effortOptions" | "newSessionWatchTimeoutMs"> & {
  isCliAlive?: DaemonServerOptions["isCliAlive"];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "cr-p1-server-"));
  const projectsDir = join(root, "projects");
  const project = join(projectsDir, "fixture");
  await mkdir(project, { recursive: true });
  const sessionFile = join(project, ID + ".jsonl");
  for (const id of [ID, OTHER]) {
    await writeFile(join(project, id + ".jsonl"), jsonl({
      type: "user", uuid: "u1", parentUuid: null, cwd: root, sessionId: id, message: { role: "user", content: "fixture" },
    }));
  }
  const tracker = new ActivityTracker({ cooldownMs: 120000 });
  const watcher = new SessionWatcher({ projectsDir });
  const store = new InteractionStore(":memory:");
  const manager = new InteractionManager(store);
  const approvals = new ApprovalBridge({ manager, onEvent: () => {} });
  const sdk = fakeP1Sdk();
  const runner = new TurnRunner({ queryFactory: sdk.factory, permissions: approvals, abortGraceMs: 10,
    gate: { isIdle: (id) => tracker.getStatus(id) === "idle", beginRun: (id) => tracker.beginRun(id), endRun: (id) => tracker.endRun(id) },
  });
  const wire = memoryHttp(t);
  const terminal = new Set<string>();
  const server = new DaemonServer({
    config: { token: TOKEN, host: "127.0.0.1", port: 0, projectsDir, uploadsDir: join(root, "uploads"),
      cooldownMs: 120000, interactionsDbPath: ":memory:", permissionTimeoutMs: 5000, relays: [] },
    tracker, watcher, approvals, runner, version: "fixture", notifier: async () => {}, claudeCliVersion: () => "2.1.330",
    isCliAlive: async (id) => terminal.has(id),
    ...options,
  });
  t.after(async () => {
    wire.close();
    await server.close();
    watcher.close();
    tracker.dispose();
    manager.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.listen();
  wire.restoreListen();

  async function subscribe(sessionId = ID, waitForSnapshot = true) {
    const ws = new WebSocket(`ws://fixture.test/ws?token=${TOKEN}`, { agent: wire.agent });
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    const subscription = {
      ws, frames,
      frame: async (type: string, predicate: (frame: Record<string, unknown>) => boolean = () => true) => {
        for (let tries = 0; tries < 200; tries++) {
          const item = frames.find((value) => value.type === type && predicate(value));
          if (item) return item;
          await delay(5);
        }
        assert.fail(`missing WS frame ${type}; saw ${JSON.stringify(frames)}`);
      },
    };
    if (waitForSnapshot) await subscription.frame("session-state");
    return subscription;
  }

  return { sessionFile, root, tracker, watcher, server, queries: sdk.queries, subscribe, terminal,
    raw: (path: string, options?: Parameters<typeof wire.fetchRaw>[1]) => wire.fetchRaw(path, { token: TOKEN, ...options }),
    unauthenticated: wire.fetchJson,
    get: (path: string) => wire.fetchJson(path, { token: TOKEN }),
    post: (path: string, post: object) => wire.fetchJson(path, { token: TOKEN, post }),
    mutate: (method: "PATCH" | "DELETE", path: string, post?: object) =>
      wire.fetchJson(path, { token: TOKEN, method, ...(post === undefined ? {} : { post }) }),
  };
}

test("P1 HTTP and WS discovery, queue receipts, quota and usage reconcile across reconnects", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  assert.equal((await h.unauthenticated("/api/commands")).status, 401);
  assert.equal((await h.get("/api/commands?cwd=/unknown")).json.error, "unknown_cwd");
  assert.equal((await h.get("/api/commands?cwd=x&sessionId=" + ID)).json.error, "ambiguous_scope");
  assert.equal((await h.get("/api/sessions/%2e%2e%2Fsecret/usage")).json.error, "invalid_session_id");
  const catalog = await h.get("/api/commands?cwd=" + encodeURIComponent(h.root));
  assert.equal(catalog.json.status, "available");
  assert.match(JSON.stringify(catalog.json), /"review".*"kind":"skill"/);
  assert.doesNotMatch(JSON.stringify(catalog.json), /"color"|"hidden"/);
  assert.equal(h.queries[0]?.params.options?.persistSession, false);

  assert.equal((await h.get(route("context"))).json.reason, "no_active_sdk");
  const live = await h.subscribe();
  const isolated = await h.subscribe(OTHER);
  const initial = randomUUID(), addition = randomUUID();
  assert.equal((await h.post(route("steer"), { runId: randomUUID(), clientMessageId: addition, text: "idle" })).json.error, "not_idle");
  const accepted = await h.post(route("messages"), { clientMessageId: initial, text: "/review packages" });
  assert.equal(accepted.status, 202);
  const runId = accepted.json.runId;
  const query = h.queries[1]!;
  assert.equal((await query.input()).message.content, "/review packages");
  query.init();
  await live.frame("commands");
  query.send({ type: "system", subtype: "commands_changed", uuid: "update", commands: [
    { name: "context", description: "Context now", argumentHint: "" },
    { name: "interactive", description: "Terminal", argumentHint: "" },
  ] });
  const update = await live.frame("commands", (frame) => JSON.stringify(frame).includes("sdk_update"));
  assert.match(JSON.stringify(update), /Context now/);
  assert.doesNotMatch(JSON.stringify(update), /interactive|review/);
  const context = await h.get(route("context"));
  assert.equal(context.json.status, "available");
  assert.match(JSON.stringify(context.json), /"totalTokens":50.*"categories"/);
  assert.doesNotMatch(JSON.stringify(context.json), /gridRows/);
  assert.equal(query.contextCalls, 1);
  query.contextFailable = true;
  assert.equal((await h.get(route("context"))).json.reason, "sdk_unavailable");
  query.send({ type: "system", subtype: "local_command_output", uuid: "cmd-output", content: "<local-command-stdout>review result</local-command-stdout>" });
  await live.frame("command-output");
  query.send({ type: "rate_limit_event", uuid: "generic", rate_limit_info: { status: "allowed" } });
  query.send({ type: "rate_limit_event", uuid: "quota", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 } });
  await live.frame("subscription-quota");
  assert.equal(live.frames.filter((frame) => frame.type === "subscription-quota").length, 1);
  const mutation = { runId, clientMessageId: addition, text: "include docs" };
  assert.equal((await h.post(route("steer"), { ...mutation, runId: randomUUID() })).json.error, "run_mismatch");
  const [a, b] = await Promise.all([h.post(route("steer"), mutation), h.post(route("steer"), mutation)]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal([a.json.replayed, b.json.replayed].filter(Boolean).length, 1);
  assert.equal((await h.post(route("messages"), { text: "legacy request" })).json.error, "not_idle");
  assert.equal((await h.post(route("steer"), { ...mutation, text: "/clear" })).json.error, "command_unavailable");

  live.ws.close();
  const reconnect = await h.subscribe();
  const active = await reconnect.frame("session-state");
  assert.equal(active.activeRunId, runId);
  assert.deepEqual(active.steering, [{ runId, clientMessageId: addition, text: "include docs", state: "queued", revision: 1 }]);
  assert.equal((await reconnect.frame("command-output")).eventId, "cmd-output");
  query.result(initial);
  assert.equal((await query.input()).message.content, "include docs");
  query.send({ type: "user", uuid: addition, isReplay: true, message: { role: "user", content: "include docs" } });
  await reconnect.frame("steer", (frame) => frame.state === "delivered");
  query.result(addition, { tokens: 8, total: 0.09 });
  await reconnect.frame("steer", (frame) => frame.state === "processed");
  await reconnect.frame("run", (frame) => frame.state === "done");
  assert.equal(isolated.frames.some((frame) => frame.type === "steer" || frame.type === "commands"), false);

  await appendFile(h.sessionFile, jsonl(
    { type: "system", subtype: "local_command", uuid: "disk-output", parentUuid: "u1", content: "<local-command-stdout>review result</local-command-stdout>" },
    { type: "cost-state", sessionId: ID, totalCostUSD: 0.09, modelUsage: { fixture: { inputTokens: 11 } } },
  ));
  const idle = await h.subscribe();
  const snapshot = await idle.frame("session-state");
  assert.equal(snapshot.activeRunId, null);
  assert.deepEqual(snapshot.steering, [{ runId, clientMessageId: addition, text: "include docs", state: "processed", revision: 3 }]);
  assert.equal((await h.post(route("steer"), mutation)).json.replayed, true);
  const usage = await h.get(route("usage"));
  assert.match(JSON.stringify(usage.json), /"input_tokens":8.*"scope":"session"/);
  assert.match(JSON.stringify(usage.json), /"sdkSession".*"total_cost_usd":0.09/);
  assert.deepEqual(usage.json.gatewayBilling, { status: "unavailable" });
  assert.match(JSON.stringify((await h.get(route("messages?limit=1"))).json), /"kind":"command_output"/);
});

test("P1 compaction has one request identity, preserves JSONL and rejects terminal ownership and stale aborts", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const original = await readFile(h.sessionFile, "utf8");
  const clientMessageId = randomUUID();
  assert.equal((await h.post(route("compact"), { clientMessageId, instructions: 4 })).json.error, "invalid_instructions");
  h.terminal.add(ID);
  assert.equal((await h.post(route("compact"), { clientMessageId })).json.status, "terminal-driving");
  h.terminal.delete(ID);
  h.tracker.noteCliAlive(OTHER);
  assert.equal((await h.get(route("context", OTHER))).json.reason, "terminal_driving");
  assert.deepEqual((await h.post(route("steer", OTHER), { runId: randomUUID(), clientMessageId, text: "blocked" })).json,
    { error: "not_idle", status: "terminal-driving", activeRunId: null });

  const live = await h.subscribe();
  const body = { clientMessageId, instructions: "Keep deployment notes" };
  const [a, b] = await Promise.all([h.post(route("compact"), body), h.post(route("compact"), body)]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.json.runId, b.json.runId);
  assert.equal([a.json.replayed, b.json.replayed].filter(Boolean).length, 1);
  assert.equal(h.queries.length, 1);
  const query = h.queries[0]!;
  const input = await query.input();
  assert.equal(input.message.content, "/compact Keep deployment notes");
  assert.equal((await h.post(route("compact"), { clientMessageId: randomUUID() })).json.error, "not_idle");
  assert.equal((await h.post(route("abort"), { runId: randomUUID() })).json.error, "run_mismatch");
  assert.equal(query.interrupts, 0);
  query.init("user");
  query.send({ type: "rate_limit_event", uuid: "gateway-window", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
  query.send({ type: "system", subtype: "status", uuid: "compacting", status: "compacting" });
  query.send({ type: "system", subtype: "compact_boundary", uuid: "boundary", compact_metadata: { trigger: "manual", pre_tokens: 120 } });
  query.result(input.uuid);
  await live.frame("compact-status");
  assert.deepEqual((await live.frame("compact-boundary")).metadata, { trigger: "manual", pre_tokens: 120 });
  assert.equal((await live.frame("compaction", (frame) => frame.state === "success")).runId, a.json.runId);
  const state = await h.get(route("state"));
  assert.match(JSON.stringify(state.json), /"compactions".*"state":"success"/);
  assert.equal(state.json.quotas, undefined);
  assert.equal(live.frames.some((frame) => frame.type === "subscription-quota"), false);
  assert.equal((await h.post(route("compact"), body)).json.state, "success");
  assert.equal(await readFile(h.sessionFile, "utf8"), original);
});

test("P1 switching subscriptions during watcher initialization discards the old snapshot", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const watch = h.watcher.watch.bind(h.watcher);
  let markOldEntered!: () => void;
  let releaseOld!: () => void;
  const oldEntered = new Promise<void>((resolve) => { markOldEntered = resolve; });
  const oldWatch = new Promise<void>((resolve) => { releaseOld = resolve; });
  t.mock.method(h.watcher, "watch", async (sessionId: string) => {
    if (sessionId === ID) {
      markOldEntered();
      await oldWatch;
    }
    return watch(sessionId);
  });
  const client = await h.subscribe(ID, false);
  await oldEntered;
  client.ws.send(JSON.stringify({ type: "unsubscribe", sessionId: ID }));
  client.ws.send(JSON.stringify({ type: "subscribe", sessionId: OTHER }));
  const current = await client.frame("session-state");
  assert.equal(current.sessionId, OTHER);
  releaseOld();
  const response = await h.post(route("messages"), { text: "old session" });
  assert.equal(response.status, 202);
  const query = h.queries[0]!;
  query.init();
  query.close();
  await delay(30);
  assert.deepEqual(client.frames.map((frame) => frame.sessionId), [OTHER]);
  assert.equal(h.watcher.watched.includes(ID), false);
});

test("P1 steer edit, delete, and send-now expose the agreed receipt and error shapes", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const live = await h.subscribe();
  const messageId = randomUUID();
  const { json: start } = await h.post(route("messages"), { text: "start", clientMessageId: randomUUID() });
  const { runId } = start;
  const first = h.queries[0]!;
  await first.input();
  const editPath = route("steer/" + messageId);
  assert.deepEqual(await h.mutate("PATCH", editPath, { runId, text: "unknown" }), {
    status: 404, json: { error: "steer_not_found" },
  });
  assert.equal((await h.post(route("steer"), { runId, clientMessageId: messageId, text: "initial text" })).json.text, "initial text");
  assert.equal((await h.mutate("PATCH", editPath, { runId, text: "   " })).json.error, "invalid_text");
  assert.equal((await h.mutate("PATCH", editPath, { runId, text: "  /reset" })).json.error, "command_unavailable");
  assert.deepEqual((await h.mutate("PATCH", editPath, { runId: randomUUID(), text: "other run" })).json,
    { error: "run_mismatch", activeRunId: runId, status: "daemon-driving" });
  assert.deepEqual(await h.mutate("PATCH", editPath, { runId, text: "edited" }), { status: 200,
    json: { sessionId: ID, runId, clientMessageId: messageId, text: "edited", state: "queued", revision: 2 } });
  assert.equal((await live.frame("steer", (frame) => frame.revision === 2)).text, "edited");
  const reconnected = await h.subscribe();
  assert.match(JSON.stringify((await reconnected.frame("session-state")).steering), /"text":"edited"/);

  for (const key of ["query", "body", "implicit"]) {
    const remove = randomUUID();
    await h.post(route("steer"), { runId, clientMessageId: remove, text: key });
    const path = route("steer/" + remove) + (key === "query" ? `?runId=${runId}` : "");
    assert.deepEqual(await h.mutate("DELETE", path, key === "body" ? { runId } : undefined), { status: 200,
      json: { sessionId: ID, runId, clientMessageId: remove, text: key, state: "cancelled", revision: 2 } });
    assert.deepEqual((await h.mutate("DELETE", path)).json, { error: "steer_not_cancellable", state: "cancelled" });
  }
  const following = randomUUID();
  await h.post(route("steer"), { runId, clientMessageId: following, text: "later" });
  const now = await h.post(editPath + "/send-now", { runId });
  assert.equal(now.status, 202);
  assert.equal(now.json.revision, 3);
  const delivered = await live.frame("steer", (frame) => frame.clientMessageId === messageId && frame.state === "delivered");
  assert.equal(delivered.revision, 4);
  assert.equal(first.interrupts, 1);
  const resumed = h.queries[1]!;
  assert.equal(resumed.params.options?.resume, ID);
  assert.equal((await resumed.input()).message.content, "edited");
  assert.deepEqual((await h.mutate("PATCH", editPath, { runId, text: "too late" })).json, { error: "steer_not_editable", state: "delivered" });
  assert.deepEqual((await h.mutate("DELETE", editPath)).json, { error: "steer_not_cancellable", state: "delivered" });
  assert.deepEqual((await h.post(editPath + "/send-now", { runId })).json, { error: "steer_not_sendable", state: "delivered" });
  resumed.result(messageId);
  assert.equal((await resumed.input()).uuid, following);
  resumed.result(following);
  await live.frame("run", (frame) => frame.state === "done");
});

test("P1 /btw is isolated, denies tools, validates requests and preserves the transcript", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  const original = await readFile(h.sessionFile, "utf8");
  const clientMessageId = randomUUID();
  assert.equal((await h.post(route("btw"), { question: " \n " })).json.error, "invalid_question");
  assert.equal((await h.post(route("btw"), { question: "bad\0input" })).json.error, "invalid_question");
  assert.equal((await h.post(route("btw"), { question: "鱼".repeat(11000) })).json.error, "invalid_question");
  assert.equal((await h.post(route("btw"), { question: "x", clientMessageId: "bad" })).json.error, "invalid_client_message_id");
  assert.equal((await h.post(route("btw", randomUUID()), { question: "missing" })).json.error, "session_not_found");
  const live = await h.subscribe();
  const active = await h.post(route("messages"), { text: "main query" });
  const primary = h.queries[0]!;
  const question = "/clear means what?";
  const reply = h.post(route("btw"), { question, clientMessageId });
  for (let tries = 0; h.queries.length < 2 && tries < 50; tries++) await delay(5);
  const side = h.queries[1]!;
  const params = side.params.options;
  assert.equal(params?.resume, ID);
  assert.equal(params?.persistSession, false);
  assert.equal(params?.permissionMode, "dontAsk");
  assert.equal(params?.strictMcpConfig, true);
  assert.deepEqual(params?.tools, []);
  assert.deepEqual(params?.settingSources, []);
  assert.deepEqual(params?.settings, { disableAllHooks: true });
  assert.deepEqual(await params?.canUseTool?.("Bash", { command: "fixture" }, {
    signal: new AbortController().signal, requestId: "side-tool", toolUseID: "side-use",
  }), { behavior: "deny", message: "Read-only /btw side chat" });
  const sent = await side.input();
  assert.equal(sent.uuid, clientMessageId);
  assert.equal(sent.message.content.startsWith("/"), false);
  assert.equal(sent.message.content.endsWith(question), true);
  assert.equal((await h.post(route("btw"), { question: "concurrent" })).json.error, "btw_unavailable");
  side.send({ type: "system", subtype: "init", model: "side-model" });
  side.result(clientMessageId, { result: "Side answer" });
  const received = await reply;
  assert.equal(received.status, 200);
  assert.deepEqual(received.json, { sessionId: ID, question, answer: "Side answer", model: "side-model",
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 } });
  assert.equal(side.closed, true);
  assert.equal(primary.interrupts, 0);
  assert.equal((await h.get(route("state"))).json.activeRunId, active.json.runId);
  assert.equal(live.frames.some((frame) => frame.type === "run-usage"), false);
  const failure = h.post(route("btw"), { question: "test failure" });
  for (let tries = 0; h.queries.length < 3 && tries < 50; tries++) await delay(5);
  h.queries[2]?.result(clientMessageId, { error: "provider error includes private info" });
  assert.deepEqual(await failure, { status: 503, json: { error: "btw_unavailable" } });
  assert.equal(await readFile(h.sessionFile, "utf8"), original);
});

test("P1 workspace reports Git branch, combined diff and bounded output, projecting MCP status only", { timeout: 8000 }, async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.get(route("workspace")), {
    status: 200, json: { git: { isGitRepo: false }, mcp: { status: "unavailable" } },
  });
  assert.equal((await h.get(route("workspace", randomUUID()))).json.error, "session_not_found");
  const git = (...args: string[]) => runGit("git", ["-C", h.root, ...args]);
  await git("init", "-q", "-b", "fixture-workspace");
  await writeFile(join(h.root, "notes.txt"), "old\nkeep\n");
  await writeFile(join(h.root, ".env.fixture"), "FIXTURE=old\n");
  await git("add", "--", "notes.txt", ".env.fixture");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture");
  await writeFile(join(h.root, "notes.txt"), "staged\nkeep\n");
  await git("add", "--", "notes.txt");
  await writeFile(join(h.root, "notes.txt"), "staged\nkeep\nworktree\n");
  await writeFile(join(h.root, ".env.fixture"), "FIXTURE=hidden\n");
  await writeFile(join(h.root, "new.txt"), "untracked");
  const index = await readFile(join(h.root, ".git/index"));
  await h.post(route("messages"), { text: "main" });
  const query = h.queries[0]!;
  query.mcpStatuses = [{ name: "fixture-tool", status: "needs-auth", config: {
    env: { AUTH: "fixture-mcp-secret" }, url: "https://example.com/?token=fixture-mcp-secret",
  }, error: "fixture-mcp-secret" }];
  const workspace = await h.get(route("workspace?cwd=/ignored"));
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.json.mcp, { status: "available", servers: [{ name: "fixture-tool", status: "needs-auth" }] });
  assert.doesNotMatch(JSON.stringify(workspace.json), /fixture-mcp-secret|\.env\.fixture|FIXTURE=hidden/);
  const first = workspace.json.git as { branch: string; dirty: boolean; diff: string; truncated: boolean; files: Array<Record<string, unknown>> };
  assert.equal(first.branch, "fixture-workspace");
  assert.equal(first.dirty, true);
  assert.equal(first.truncated, false);
  assert.match(first.diff, /-old\n\+staged\n keep\n\+worktree/);
  assert.deepEqual(first.files.find(({ path }) => path === "notes.txt"), { path: "notes.txt", status: "MM", additions: 2, deletions: 1 });
  assert.deepEqual(first.files.find(({ path }) => path === "new.txt"), { path: "new.txt", status: "??" });
  assert.deepEqual(await readFile(join(h.root, ".git/index")), index);

  await writeFile(join(h.root, "notes.txt"), "鱼".repeat(60000) + "\n");
  const bounded = (await h.get(route("workspace"))).json.git as { diff: string; truncated: boolean };
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.diff) > 120 * 1024 && Buffer.byteLength(bounded.diff) <= 128 * 1024);
  const sha = (await git("rev-parse", "HEAD")).stdout.trim().slice(0, 7);
  await git("switch", "-q", "--detach");
  const detached = (await h.get(route("workspace"))).json.git as { branch: string };
  assert.equal(detached.branch, sha);
  await writeFile(join(h.root, ".gitattributes"), "notes.txt filter=fixture\n");
  await git("config", "filter.fixture.clean", "touch filter-executed; cat");
  assert.equal((await h.get(route("workspace"))).status, 200);
  await assert.rejects(stat(join(h.root, "filter-executed")), { code: "ENOENT" });
});

test("session file entry points reject unsafe IDs, directories and linked transcripts", async (t) => {
  const h = await harness(t);
  const project = dirname(h.sessionFile);
  await mkdir(join(project, "directory.jsonl"));
  await symlink(h.sessionFile, join(project, "linked.jsonl"));
  for (const id of ["%2E%2E%2Fnew", "back%5Cslash", "bad..id", "bad%00", "%FF", "directory", "linked"]) {
    for (const [path, method] of [
      ["messages", "GET"], ["messages", "POST"], ["file?path=x.png", "GET"],
      ["files/meta?path=x.png", "GET"], ["files/content?path=x.png", "GET"], ["upload?filename=x.png", "POST"],
    ] as const) {
      const response = await h.raw(route(path, id), {
        method, ...(method === "POST" ? { body: JSON.stringify({ text: "x" }) } : {}),
      });
      assert.equal(response.status, 404, `${method} ${id}/${path}`);
    }
  }
});

test("uploads are immutable across same-millisecond writes and reject linked upload directories", async (t) => {
  const h = await harness(t);
  t.mock.method(Date, "now", () => 123_456);
  const uploads = join(h.root, "uploads");
  const paths = await Promise.all(["first", "second"].map(async (body) => {
    const response = await h.raw("/api/upload?filename=same.png", { method: "POST", body });
    assert.equal(response.status, 200);
    return (JSON.parse(response.body.toString()) as { path: string }).path;
  }));
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), ["first", "second"]);
  for (const [index, path] of paths.entries()) {
    const readback = await h.raw(`/api/uploads/new/${basename(path)}`);
    assert.equal(readback.status, 200);
    assert.equal(readback.body.toString(), ["first", "second"][index]);
    assert.match(readback.headers["cache-control"] ?? "", /immutable/);
  }
  const outside = join(h.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(uploads, ID));
  const rejected = await h.raw(route("upload?filename=blocked.png"), { method: "POST", body: "blocked" });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await readdir(outside), []);
});

test("file readers share sensitive path checks and bound ranges by the full file size", async (t) => {
  const h = await harness(t);
  const dir = join(h.root, "uploads", "new");
  await mkdir(dir, { recursive: true });
  const sensitive = join(h.root, ".env.png");
  const alias = join(dir, "alias.png");
  const outside = join(h.root, "ordinary.png");
  await writeFile(sensitive, "fixture");
  await symlink(sensitive, alias);
  await writeFile(outside, "ordinary png");
  await symlink(outside, join(dir, "outside.png"));
  for (const endpoint of ["file", "files/meta", "files/content"]) {
    const response = await h.raw(route(`${endpoint}?path=${encodeURIComponent(alias)}`));
    assert.equal(response.status, 403);
  }
  assert.equal((await h.raw("/api/uploads/new/alias.png")).status, 403);
  assert.equal((await h.raw("/api/uploads/new/outside.png")).status, 404);
  const partial = await h.raw(route("files/content?path=ordinary.png"), { range: "bytes=1-3" });
  assert.equal(partial.status, 206);
  assert.equal(partial.body.toString(), "rdi");
  assert.equal(partial.headers["content-range"], "bytes 1-3/12");
  const large = join(dir, "large.png");
  await writeFile(large, "");
  await truncate(large, 64 * 1024 * 1024 + 1);
  assert.equal((await h.raw("/api/uploads/new/large.png")).status, 413);
  for (const endpoint of ["file", "files/meta", "files/content"]) {
    const response = await h.raw(route(`${endpoint}?path=${encodeURIComponent(large)}`), { range: "bytes=0-1" });
    assert.equal(response.status, 413);
  }
});

test("message admission checks live CLI ownership and rechecks closing after awaiting it", async (t) => {
  let finishProbe!: (live: boolean) => void;
  let enterProbe!: () => void;
  const entered = new Promise<void>((resolve) => { enterProbe = resolve; });
  let calls = 0;
  const h = await harness(t, {
    isCliAlive: async () => {
      if (calls++ === 0) return true;
      enterProbe();
      return new Promise((resolve) => { finishProbe = resolve; });
    },
  });
  const send = () => h.post(route("messages"), { text: "resume" });
  assert.equal(h.tracker.getStatus(ID), "idle");
  assert.deepEqual(await send(), { status: 409, json: { error: "not_idle", status: "terminal-driving" } });
  const pending = send();
  await entered;
  const closing = h.server.close();
  finishProbe(false);
  assert.deepEqual(await pending, { status: 503, json: { error: "server_closing" } });
  assert.equal(h.queries.length, 0);
  await closing;
});

test("explicit release protects a run started before or during the live CLI probe", async (t) => {
  let finishProbe!: (live: boolean) => void;
  let enterProbe!: () => void;
  const entered = new Promise<void>((resolve) => { enterProbe = resolve; });
  let calls = 0;
  const h = await harness(t, {
    isCliAlive: async () => {
      if (calls++ > 0) return false;
      enterProbe();
      return new Promise((resolve) => { finishProbe = resolve; });
    },
  });
  const release = () => h.post(route("abort"), { action: "release" });
  const pending = release();
  await entered;
  const started = await h.post(route("messages"), { text: "new turn" });
  assert.equal(started.status, 202);
  finishProbe(false);
  for (const response of [await pending, await release()]) {
    assert.deepEqual(response, {
      status: 409, json: { error: "run_mismatch", activeRunId: started.json.runId, status: "daemon-driving" },
    });
  }
  assert.equal(h.queries[0]?.interrupts, 0);
});

test("concurrent subscribers recover when a new transcript lands and effort uses its active cwd", async (t) => {
  const cwdSeen: string[] = [];
  const h = await harness(t, {
    effortOptions: async (cwd) => { cwdSeen.push(cwd); return { levels: ["high"], verified: true }; },
  });
  const started = await h.post("/api/sessions", { cwd: h.root, text: "new turn" });
  assert.equal(started.status, 202);
  const sessionId = String(started.json.sessionId);
  const [first, second, effort] = await Promise.all([
    h.subscribe(sessionId), h.subscribe(sessionId), h.get(`/api/effort-levels?sessionId=${sessionId}`),
  ]);
  assert.deepEqual(effort, { status: 200, json: { levels: ["high"], verified: true } });
  assert.deepEqual(cwdSeen, [h.root]);
  await writeFile(join(dirname(h.sessionFile), `${sessionId}.jsonl`),
    jsonl({ type: "user", uuid: "u1", cwd: h.root, sessionId }));
  await Promise.all([first.frame("resync"), second.frame("resync")]);
  assert.equal(h.watcher.watched.filter((id) => id === sessionId).length, 1);
});

test("unwritten new sessions stop retrying and release watcher resources", async (t) => {
  const h = await harness(t, { newSessionWatchTimeoutMs: 500 });
  const watch = t.mock.method(h.watcher, "watch");
  const started = await h.post("/api/sessions", { cwd: h.root, text: "new turn" });
  assert.equal(started.status, 202);
  await h.subscribe(String(started.json.sessionId));
  await delay(600);
  const attempts = watch.mock.callCount();
  assert.ok(attempts >= 2);
  await delay(250);
  assert.equal(watch.mock.callCount(), attempts);
  assert.deepEqual(h.watcher.watched, []);
});

test("relay lets /btw wait for headers beyond the standard HTTP timeout", async (t) => {
  const wire = memoryHttp(t);
  const secret = generateDeviceKey();
  const relay = await startRelay({
    secret, host: "127.0.0.1", port: 0, maxStreams: 8, maxBodyBytes: 1024,
    timings: { headTimeoutMs: 20, sideChatHeadTimeoutMs: 1000 },
    log: () => {},
  });
  wire.restoreListen();
  t.after(async () => {
    wire.close();
    await relay.close();
  });
  const key = generateDeviceKey();
  const id = deriveDeviceId(key);
  const agent = new WebSocket("ws://fixture.test/agent", {
    agent: wire.agent, headers: { Authorization: `Bearer ${secret}`, "X-Device-Id": id, "X-Device-Key": key },
  });
  let sideChatSid: number | undefined;
  agent.on("message", (data, binary) => {
    if (binary) return;
    const parsed = parseControl(data.toString());
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.t === "open" && frame.path.includes("/btw?")) sideChatSid = frame.sid;
    if (frame.t === "end" && frame.sid === sideChatSid) {
      const { sid } = frame;
      void delay(80).then(() => {
        agent.send(encodeControl({ t: "head", sid, status: 200, headers: {} }));
        agent.send(encodeControl({ t: "end", sid }));
      });
    }
  });
  await once(agent, "open");
  const ordinary = await wire.fetchRaw(`/d/${id}/api/health`);
  assert.equal(ordinary.status, 504);
  const side = await wire.fetchRaw(`/d/${id}${route("btw?fixture=1")}`, { method: "POST", body: "{}" });
  assert.equal(side.status, 200);
});

test("relay connector rejects reload before forwarding to the daemon", async (t) => {
  const wire = memoryHttp(t);
  const secret = generateDeviceKey();
  const relay = await startRelay({
    secret, host: "127.0.0.1", port: 0, maxStreams: 8, maxBodyBytes: 1024, log: () => {},
  });
  wire.restoreListen();
  const deviceKey = generateDeviceKey();
  const deviceId = deriveDeviceId(deviceKey);
  let connected!: Promise<unknown>;
  let link: WebSocket | undefined;
  const MemoryWebSocket = new Proxy(WebSocket, {
    construct(_target, [address, options]: [string | URL, WebSocket.ClientOptions]) {
      const socket = new WebSocket(address, { ...options, agent: wire.agent });
      connected = once(socket, "open");
      link = socket;
      return socket;
    },
  });
  const connector = new RelayConnector({
    settings: { secret, deviceKey, deviceId, url: `http://127.0.0.1:${relay.port}` },
    WebSocket: MemoryWebSocket, log: () => {},
  });
  t.after(async () => {
    if (link && link.readyState !== WebSocket.CLOSED) {
      const closed = once(link, "close");
      link.terminate();
      await closed;
    }
    await connector.stop();
    wire.close();
    await relay.close();
  });
  connector.start({ host: "127.0.0.1", port: 1 });
  await connected;
  const result = await wire.fetchJson(`/d/${deviceId}/api/relay/reload?fixture=1`, { token: TOKEN, post: {} });
  assert.deepEqual(result, { status: 403, json: { error: "loopback_only" } });
});
