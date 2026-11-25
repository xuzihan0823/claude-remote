import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionAdapter } from "../src/permission-adapter.js";

const options = (signal = new AbortController().signal) => ({ signal, requestId: "req", toolUseID: "tool" });

test("approval decisions allow and deny without persistent permission updates", async () => {
  const allow = createPermissionAdapter({ request: async () => ({ type: "allow_once" }) }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await allow("Bash", { command: "pwd" }, options()), { behavior: "allow", updatedInput: { command: "pwd" } });
  const deny = createPermissionAdapter({ request: async () => ({ type: "deny", message: "no" }) }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await deny("Bash", {}, options()), { behavior: "deny", message: "no" });
});

test("AskUserQuestion returns answers in updatedInput", async () => {
  let kind = "";
  const callback = createPermissionAdapter({ request: async (request) => { kind = request.kind; return { type: "answer", answers: { Continue: "Yes" } }; } }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await callback("AskUserQuestion", { questions: [] }, options()), { behavior: "allow", updatedInput: { questions: [], answers: { Continue: "Yes" } } });
  assert.equal(kind, "question");
});

test("timeout and abort fail closed", async () => {
  const callback = createPermissionAdapter({ request: async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) }, { sessionKey: "s", userId: "u" }, { timeoutMs: 5 });
  assert.equal((await callback("Bash", {}, options()))?.behavior, "deny");
  const controller = new AbortController(); controller.abort();
  assert.equal((await callback("Bash", {}, options(controller.signal)))?.behavior, "deny");
});

test("run cancellation wins over a broker allow returned after cancellation", async () => {
  const controller = new AbortController();
  const callback = createPermissionAdapter({ request: async () => {
    controller.abort();
    return { type: "allow_once" };
  } }, { sessionKey: "s", userId: "u" }, { signal: controller.signal });
  assert.equal((await callback("Bash", {}, options()))?.behavior, "deny");
});

test("the absolute deadline denies an allow returned before the timeout callback runs", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const callback = createPermissionAdapter({ request: async () => {
    now += 50;
    return { type: "allow_once" };
  } }, { sessionKey: "s", userId: "u" }, { timeoutMs: 50 });
  assert.equal((await callback("Bash", {}, options()))?.behavior, "deny");
});

test("ExitPlanMode exposes only native metadata and applies selected updates in SDK order", async () => {
  const input = {
    plan: "# Plan\n\n1. Review files.\n2. Run tests.\n",
    planFilePath: "/tmp/plan.md",
    allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
    nativeExtra: true,
  };
  const suggestions: NonNullable<Parameters<ReturnType<typeof createPermissionAdapter>>[2]["suggestions"]> = [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
    { type: "addRules", behavior: "allow", rules: [{ toolName: "Read", ruleContent: "test/**" }], destination: "localSettings" },
    { type: "addDirectories", directories: ["/tmp/tests"], destination: "cliArg" },
  ];
  const callback = createPermissionAdapter({ request: async (request) => {
    assert.deepEqual(request, {
      requestId: "req", sessionKey: "s", userId: "u", kind: "approval", toolName: "ExitPlanMode",
      input, prompt: "Approve plan?", decisionReason: "Plan complete", blockedPath: "/tmp/tests",
      agentId: "agent", toolUseId: "tool",
      plan: { text: input.plan, filePath: input.planFilePath, allowedPrompts: input.allowedPrompts },
      suggestions: [
        { id: "req:0", type: "setMode", destination: "session", description: "Set permission mode to acceptEdits" },
        { id: "req:1", type: "addRules", destination: "localSettings", description: "Add allow rules: Read(test/**)" },
        { id: "req:2", type: "addDirectories", destination: "cliArg", description: "Add directories: /tmp/tests" },
      ],
    });
    return { type: "allow_once", applySuggestionIds: ["req:2", "req:0"] };
  } }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await callback("ExitPlanMode", input, {
    ...options(), suggestions, title: "Approve plan?", decisionReason: "Plan complete",
    blockedPath: "/tmp/tests", agentID: "agent",
  }), { behavior: "allow", updatedInput: input, updatedPermissions: [suggestions[0], suggestions[2]] });
});

test("missing SDK suggestions are omitted and plain or empty approvals never return updates", async () => {
  const allow = createPermissionAdapter({ request: async (request) => {
    assert.equal(Object.hasOwn(request, "suggestions"), false);
    assert.equal(Object.hasOwn(request, "plan"), false);
    return { type: "allow_once" };
  } }, { sessionKey: "s", userId: "u" });
  assert.deepEqual(await allow("Read", {}, options()), { behavior: "allow", updatedInput: {} });

  const sdkOptions = { ...options(), suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } as const;
  const nativeOptions = { ...sdkOptions, suggestions: [...sdkOptions.suggestions] };
  for (const applySuggestionIds of [undefined, [], ["req:0", "req:0"], ["req:0", "req:1"], ["other:0"]]) {
    const callback = createPermissionAdapter({ request: async () => ({
      type: "allow_once", ...(applySuggestionIds === undefined ? {} : { applySuggestionIds }),
    }) }, { sessionKey: "s", userId: "u" });
    const result = await callback("Read", {}, nativeOptions);
    if (applySuggestionIds?.length) assert.equal(result?.behavior, "deny");
    else assert.deepEqual(result, { behavior: "allow", updatedInput: {} });
  }
});
