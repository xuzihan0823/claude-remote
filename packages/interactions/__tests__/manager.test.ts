import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  InteractionAlreadyResolvedError,
  InteractionManager,
  InteractionUnauthorizedError,
  InvalidPermissionSuggestionError,
  InteractionTypeError,
} from "../src/manager.js";
import { decisionToAgentSdkResult } from "../src/sdk-contract.js";
import { InteractionStore } from "../src/store.js";

function setup(options: ConstructorParameters<typeof InteractionManager>[1] = {}) {
  const store = new InteractionStore();
  const manager = new InteractionManager(store, {
    autoScheduleExpiry: false,
    ...options,
  });
  return {
    store,
    manager,
    close(): void {
      manager.close();
      store.close();
    },
  };
}

test("allow_once resolves an approval and wakes all concurrent waiters", async () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session-1",
      userId: "user-1",
      payload: { toolName: "Bash", input: { command: "pwd" }, prompt: "Run pwd?" },
    });
    const first = context.manager.awaitDecision(approval.interactionId);
    const second = context.manager.awaitDecision(approval.interactionId);

    const resolution = context.manager.resolve(approval.interactionId, "user-1", { type: "allow_once" });

    assert.equal(resolution.record.status, "allowed");
    assert.deepEqual(await Promise.all([first, second]), [
      { type: "allow_once" },
      { type: "allow_once" },
    ]);
    assert.deepEqual(
      decisionToAgentSdkResult(resolution.decision, { command: "pwd" }),
      { behavior: "allow", updatedInput: { command: "pwd" } },
    );
  } finally {
    context.close();
  }
});

test("first resolution wins and duplicate resolution is rejected", () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      payload: { toolName: "Write", input: {}, prompt: "Write?" },
    });

    const first = context.manager.resolve(approval.interactionId, "owner", {
      type: "deny",
      message: "User denied this action",
    });
    assert.equal(first.record.status, "denied");
    assert.throws(
      () => context.manager.resolve(approval.interactionId, "owner", { type: "allow_once" }),
      InteractionAlreadyResolvedError,
    );
  } finally {
    context.close();
  }
});

test("non-owner user cannot resolve an interaction", () => {
  const context = setup();
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      payload: { toolName: "Edit", input: {}, prompt: "Edit?" },
    });

    assert.throws(
      () => context.manager.resolve(approval.interactionId, "attacker", { type: "allow_once" }),
      InteractionUnauthorizedError,
    );
    assert.equal(context.manager.get(approval.interactionId)?.status, "pending");
    assert.equal(context.store.listAudit(approval.interactionId).at(-1)?.action, "unauthorized_resolution");
  } finally {
    context.close();
  }
});

test("expired approvals auto-deny and resolve awaitDecision", async () => {
  let now = 1_000;
  const context = setup({ now: () => now });
  try {
    const approval = context.manager.createApproval({
      sessionKey: "session",
      userId: "owner",
      ttlMs: 50,
      payload: { toolName: "Bash", input: {}, prompt: "Run?" },
    });
    const waiting = context.manager.awaitDecision(approval.interactionId);
    now = 1_051;

    const expired = context.manager.expireDue();

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, "expired");
    assert.deepEqual(await waiting, { type: "deny", message: "Interaction timed out" });
    assert.equal(context.store.listAudit(approval.interactionId).at(-1)?.action, "auto_deny_timeout");
  } finally {
    context.close();
  }
});

test("startup auto-denies pending records and writes restart audit", () => {
  const store = new InteractionStore();
  const first = new InteractionManager(store, { autoScheduleExpiry: false });
  const approval = first.createApproval({
    sessionKey: "session",
    userId: "owner",
    payload: { toolName: "Bash", input: {}, prompt: "Run?" },
  });
  first.close();

  const restarted = new InteractionManager(store, { autoScheduleExpiry: false, now: () => 9_000 });
  try {
    assert.equal(restarted.get(approval.interactionId)?.status, "denied");
    assert.equal(store.listAudit(approval.interactionId).at(-1)?.action, "auto_deny_restart");
  } finally {
    restarted.close();
    store.close();
  }
});

test("question resolution records answers and maps to SDK result", () => {
  const context = setup();
  try {
    const question = context.manager.createQuestion({
      sessionKey: "session",
      userId: "owner",
      payload: {
        questions: [{
          question: "Which database?",
          header: "Database",
          multiSelect: false,
          options: [
            { label: "SQLite", description: "Local database" },
            { label: "Postgres", description: "Server database" },
          ],
        }],
      },
    });
    const resolution = context.manager.resolve(question.interactionId, "owner", {
      type: "answer",
      answers: { "Which database?": "SQLite" },
    });

    assert.equal(resolution.record.status, "answered");
    assert.deepEqual(resolution.decision, {
      type: "answer",
      answers: { "Which database?": "SQLite" },
    });
    assert.deepEqual(
      decisionToAgentSdkResult(resolution.decision, { questions: question.payload.questions }),
      {
        behavior: "allow",
        updatedInput: {
          questions: question.payload.questions,
          answers: { "Which database?": "SQLite" },
        },
      },
    );
  } finally {
    context.close();
  }
});

test("interaction IDs are unique high-entropy URL-safe values", () => {
  const context = setup();
  try {
    const ids = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      const record = context.manager.createApproval({
        sessionKey: "session",
        userId: "owner",
        payload: { toolName: "Read", input: {}, prompt: "Read?" },
      });
      assert.match(record.interactionId, /^[A-Za-z0-9_-]{24}$/);
      ids.add(record.interactionId);
    }
    assert.equal(ids.size, 1_000);
  } finally {
    context.close();
  }
});

test("a decision at the exact deadline atomically settles as expired before the timer runs", async (t) => {
  let now = 1_000;
  const context = setup({ now: () => now });
  t.after(() => context.close());
  const approval = context.manager.createApproval({
    sessionKey: "session", userId: "owner", ttlMs: 50,
    payload: { toolName: "Bash", input: {}, prompt: "Run?" },
  });
  const waiter = context.manager.awaitDecision(approval.interactionId);
  now = approval.expiresAt;
  const result = context.manager.resolve(approval.interactionId, "owner", { type: "allow_once" });
  assert.equal(result.record.status, "expired");
  assert.equal(result.decision.type, "deny");
  assert.deepEqual(await waiter, result.decision);
  assert.equal(context.store.listAudit(approval.interactionId).at(-1)?.action, "auto_deny_timeout");
});

test("a storage error in cancellation still denies every waiter", async (t) => {
  const context = setup();
  t.after(() => context.close());
  const approval = context.manager.createApproval({
    sessionKey: "session", userId: "owner",
    payload: { toolName: "Bash", input: {}, prompt: "Run?" },
  });
  const controller = new AbortController();
  const waiters = [context.manager.awaitDecision(approval.interactionId, controller.signal),
    context.manager.awaitDecision(approval.interactionId)];
  t.mock.method(context.store, "resolve", () => { throw new Error("storage unavailable"); });
  controller.abort();
  assert.deepEqual((await Promise.all(waiters)).map((decision) => decision.type), ["deny", "deny"]);
});

test("an expiry callback denies its waiters even if SQLite cannot record the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let now = 500;
  const context = setup({ autoScheduleExpiry: true, now: () => now });
  t.after(() => context.close());
  const approval = context.manager.createApproval({
    sessionKey: "session", userId: "owner", ttlMs: 5,
    payload: { toolName: "Bash", input: {}, prompt: "Run?" },
  });
  const waiter = context.manager.awaitDecision(approval.interactionId);
  t.mock.method(context.store, "resolve", () => { throw new Error("storage unavailable"); });
  now += 5;
  t.mock.timers.tick(5);
  assert.equal((await waiter).type, "deny");
});

test("suggestion choices are validated against the persisted approval before settling", async (t) => {
  const context = setup();
  t.after(() => context.close());
  const payload = {
    toolName: "ExitPlanMode", input: {}, prompt: "Approve?", plan: { text: "# Plan" },
    suggestions: [{ id: "native:0", type: "setMode", destination: "session", description: "Accept edits" }],
  } as const;
  const approval = context.manager.createApproval({
    sessionKey: "s", userId: "u", payload: { ...payload, suggestions: [...payload.suggestions] },
  });
  assert.deepEqual(context.store.get(approval.interactionId)?.payload, payload);
  const waiter = context.manager.awaitDecision(approval.interactionId);
  for (const applySuggestionIds of [["fake"], ["native:0", "native:0"], ["native:0", "native:1"]]) {
    assert.throws(() => context.manager.resolve(approval.interactionId, "u", { type: "allow_once", applySuggestionIds }),
      InvalidPermissionSuggestionError);
    assert.equal(context.store.get(approval.interactionId)?.status, "pending");
  }
  const decision = { type: "allow_once", applySuggestionIds: ["native:0"] } as const;
  const result = context.manager.resolve(approval.interactionId, "u", { ...decision, applySuggestionIds: [...decision.applySuggestionIds] });
  assert.deepEqual(result.record.decision, decision);
  assert.deepEqual(await waiter, decision);
});

const elicitation = {
  sessionKey: "session", userId: "owner",
  payload: { mode: "form" as const, serverName: "fixture", message: "Choose", requestedSchema: { type: "object" } },
};

test("elicitation decision wakes live waiters without persisting submitted fields", async (t) => {
  const { manager, store, close } = setup();
  t.after(close);
  const { interactionId } = manager.createElicitation(elicitation);
  const waiting = manager.awaitDecision(interactionId);
  assert.throws(() => manager.resolve(interactionId, "owner", { type: "allow_once" }), InteractionTypeError);
  const decision = { type: "elicitation", action: "accept", content: { choice: "fixture-value" } } as const;
  assert.equal(manager.resolve(interactionId, "owner", decision).record.status, "allowed");
  assert.deepEqual(await waiting, decision);
  assert.deepEqual(store.get(interactionId)?.decision, { type: "elicitation", action: "accept" });
  assert.doesNotMatch(JSON.stringify(store.listAudit(interactionId)), /fixture-value/);
});

test("elapsed deadlines and cancellation settle elicitation as cancel", async (t) => {
  let now = 1_000;
  const { manager, store, close } = setup({ now: () => now });
  t.after(close);
  const timed = manager.createElicitation({ ...elicitation, ttlMs: 5 });
  const waited = manager.awaitDecision(timed.interactionId);
  now = timed.expiresAt;
  assert.equal(manager.resolve(timed.interactionId, "owner", { type: "elicitation", action: "accept" }).record.status, "expired");
  const cancel = { type: "elicitation", action: "cancel" };
  assert.deepEqual(await waited, cancel);
  assert.deepEqual(store.get(timed.interactionId)?.decision, cancel);

  const aborted = manager.createElicitation(elicitation);
  const controller = new AbortController();
  const waiting = manager.awaitDecision(aborted.interactionId, controller.signal);
  controller.abort();
  assert.deepEqual(await waiting, cancel);
  assert.deepEqual(store.get(aborted.interactionId)?.decision, cancel);
});

test("a legacy database keeps its pending payload and closes it safely on startup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "interaction-v2-09-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.sqlite");
  const payload = { toolName: "Read", input: { file_path: "/tmp/example.txt" }, prompt: "Read?" };
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`CREATE TABLE interactions (
      interaction_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'question')), payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'answered', 'expired')),
      expires_at INTEGER NOT NULL, resolved_at INTEGER, decision TEXT, created_at INTEGER NOT NULL
    )`);
    legacy.prepare("INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old-approval", "old-session", "owner", "approval", JSON.stringify(payload), "pending", 60_000, null, null, 1_000);
  } finally {
    legacy.close();
  }
  const store = new InteractionStore(path);
  try {
    assert.deepEqual(store.listPending().map((record) => record.payload), [payload]);
    const manager = new InteractionManager(store, { now: () => 2_000 });
    try {
      const record = manager.get("old-approval");
      assert.deepEqual(record?.payload, payload);
      assert.equal(record?.status, "denied");
      assert.equal(record?.decision?.type, "deny");
      assert.equal(store.listAudit("old-approval").at(-1)?.action, "auto_deny_restart");
      assert.throws(() => manager.resolve("old-approval", "owner", { type: "allow_once", applySuggestionIds: ["native:0"] }),
        InteractionAlreadyResolvedError);
    } finally {
      manager.close();
    }
  } finally {
    store.close();
  }
});

test("opening a legacy SQLite database preserves rows and audit; restart cancels pending elicitation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "interactions-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "interactions.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE interactions (
      interaction_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'question')), payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'answered', 'expired')),
      expires_at INTEGER NOT NULL, resolved_at INTEGER, decision TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX interactions_pending_expiry ON interactions(status, expires_at);
    CREATE TABLE interaction_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL,
      action TEXT NOT NULL, actor_user_id TEXT, detail TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO interactions VALUES
      ('old-approval', 'session', 'owner', 'approval', '{"toolName":"Read","input":{},"prompt":"Read?"}', 'allowed', 1000, 501, '{"type":"allow_once"}', 500),
      ('old-question', 'session', 'owner', 'question', '{"questions":[]}', 'answered', 1000, 502, '{"type":"answer","answers":{}}', 500);
    INSERT INTO interaction_audit VALUES (1, 'old-approval', 'allow_once', 'owner', NULL, 501);
  `);
  legacy.close();

  const store = new InteractionStore(path);
  const manager = new InteractionManager(store, { now: () => 600 });
  const { interactionId } = manager.createElicitation(elicitation);
  const waiting = manager.awaitDecision(interactionId);
  manager.close();
  assert.deepEqual(await waiting, { type: "elicitation", action: "cancel" });
  store.close();

  const reopened = new InteractionStore(path);
  const restarted = new InteractionManager(reopened, { now: () => 700 });
  t.after(() => { restarted.close(); reopened.close(); });
  assert.deepEqual(restarted.get("old-approval")?.decision, { type: "allow_once" });
  assert.deepEqual(restarted.get("old-question")?.decision, { type: "answer", answers: {} });
  assert.equal(reopened.listAudit("old-approval")[0]?.action, "allow_once");
  assert.equal(restarted.get(interactionId)?.status, "denied");
  assert.deepEqual(await restarted.awaitDecision(interactionId), { type: "elicitation", action: "cancel" });
});
