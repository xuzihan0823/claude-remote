import assert from "node:assert/strict";
import test from "node:test";

import type { QueryFactory } from "../src/sdk-bridge.js";
import { startSdkQuery } from "../src/sdk-bridge.js";

type QueryParams = Parameters<QueryFactory>[0];
type SdkQuery = ReturnType<QueryFactory>;

function fakeQuery(): { factory: QueryFactory; params: () => QueryParams | undefined } {
  let captured: QueryParams | undefined;
  const factory = ((params: QueryParams): SdkQuery => {
    captured = params;
    const generator = (async function* () {})();
    const query = generator as unknown as Record<string, unknown>;
    query.interrupt = async (): Promise<void> => undefined;
    query.close = (): void => undefined;
    return generator as unknown as SdkQuery;
  }) as unknown as QueryFactory;
  return { factory, params: () => captured };
}

function options(factory: QueryFactory, extra: { resume?: string; sessionId?: string; model?: string } = {}) {
  const handle = startSdkQuery({
    cwd: "/tmp/project",
    prompt: "hello",
    canUseTool: async () => ({ behavior: "deny", message: "test" }),
    signal: new AbortController().signal,
    ...extra,
  }, factory);
  return handle;
}

test("resume turn passes model override and omits sessionId", () => {
  const fake = fakeQuery();
  const handle = options(fake.factory, { resume: "11111111-1111-4111-8111-111111111111", model: "fable" });
  const sdkOptions = fake.params()?.options as Record<string, unknown>;
  assert.equal(sdkOptions.resume, "11111111-1111-4111-8111-111111111111");
  assert.equal(sdkOptions.model, "fable");
  assert.equal(Object.hasOwn(sdkOptions, "sessionId"), false);
  handle.close();
});

test("new session passes explicit sessionId and model, without resume", () => {
  const fake = fakeQuery();
  const handle = options(fake.factory, { sessionId: "22222222-2222-4222-8222-222222222222", model: "claude-fable-5" });
  const sdkOptions = fake.params()?.options as Record<string, unknown>;
  assert.equal(sdkOptions.sessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(sdkOptions.model, "claude-fable-5");
  assert.equal(Object.hasOwn(sdkOptions, "resume"), false);
  handle.close();
});

test("omitted model remains omitted so SDK follows the Mac default", () => {
  const fake = fakeQuery();
  const handle = options(fake.factory, { resume: "33333333-3333-4333-8333-333333333333" });
  const sdkOptions = fake.params()?.options as Record<string, unknown>;
  assert.equal(Object.hasOwn(sdkOptions, "model"), false);
  handle.close();
});

test("resume and explicit sessionId are rejected as an invalid SDK option combination", () => {
  const fake = fakeQuery();
  assert.throws(() => options(fake.factory, {
    resume: "44444444-4444-4444-8444-444444444444",
    sessionId: "55555555-5555-4555-8555-555555555555",
  }), { name: "TypeError" });
  assert.equal(fake.params(), undefined);
});

test("env overrides CLAUDE_CODE_ENTRYPOINT to claude-remote while inheriting process.env", () => {
  const fake = fakeQuery();
  const handle = options(fake.factory, { resume: "66666666-6666-4666-8666-666666666666" });
  const sdkOptions = fake.params()?.options as Record<string, unknown>;
  const env = sdkOptions.env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "claude-remote");
  // SDK options.env replaces the subprocess env entirely, so process.env must be
  // inherited explicitly. PATH is present on every realistic platform.
  assert.ok(typeof env.PATH === "string" && env.PATH.length > 0, "PATH should be inherited from process.env");
  handle.close();
});
