import assert from "node:assert/strict";
import { test } from "node:test";

import { createElicitationAdapter, type ElicitationBroker } from "../src/elicitation-adapter.js";

const context = { sessionKey: "session", runId: "run", userId: "owner" };
const form = { serverName: "fixture", message: "Choose a region", requestedSchema: { type: "object", properties: { region: { type: "string" } } } };
const url = { mode: "url", serverName: "fixture", message: "Authorize access", url: "https://example.com/authorize?state=opaque%2Fvalue", elicitationId: "auth-1" } as const;
const sdkOptions = () => ({ signal: new AbortController().signal });

test("elicitation projects form and URL payloads and forwards explicit replies", async () => {
  const requests: Parameters<ElicitationBroker["requestElicitation"]>[0][] = [];
  const callback = createElicitationAdapter({ async requestElicitation(request) {
    requests.push(request);
    return request.payload.mode === "form" ? { action: "accept", content: { region: "test", scopes: ["read"], checked: true, count: 2 } } : { action: "accept" };
  } }, context);
  assert.deepEqual(await callback({ ...form, title: "unsolicited", url: "https://example.com/ignored" }, sdkOptions()), {
    action: "accept", content: { region: "test", scopes: ["read"], checked: true, count: 2 },
  });
  assert.deepEqual(await callback({ ...url, requestedSchema: form.requestedSchema }, sdkOptions()), { action: "accept" });
  assert.deepEqual(requests, [{ ...context, payload: { ...form, mode: "form" } }, { ...context, payload: url }]);
});

test("unsafe URLs, malformed schemas and already aborted SDK requests never reach the broker", async () => {
  const broker = { async requestElicitation() { return { action: "accept" as const }; } };
  const request = test.mock.method(broker, "requestElicitation");
  const callback = createElicitationAdapter(broker, context);
  for (const value of ["javascript:alert(0)", "http://example.com/", "https:example.com", "https:///example.com", "https://example.com\\@other.example", "https://name:password@example.com", "https://@example.com", "https://exa\nmple.com", "https://[broken"]) {
    assert.deepEqual(await callback({ ...url, url: value }, sdkOptions()), { action: "cancel" }, value);
  }
  const { elicitationId: _id, ...withoutId } = url;
  assert.deepEqual(await callback(withoutId, sdkOptions()), { action: "cancel" });
  assert.deepEqual(await callback({ serverName: form.serverName, message: form.message }, sdkOptions()), { action: "cancel" });
  assert.deepEqual(await callback(form, { signal: AbortSignal.abort() }), { action: "cancel" });
  assert.equal(request.mock.callCount(), 0);
});

test("broker rejection, bad results, aborts and timeout all return cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const failing = createElicitationAdapter({ async requestElicitation() { throw new Error("unavailable"); } }, context);
  assert.deepEqual(await failing(form, sdkOptions()), { action: "cancel" });
  const invalid = createElicitationAdapter({ async requestElicitation() { return { action: "accept", content: { nested: {} } }; } }, context);
  assert.deepEqual(await invalid(form, sdkOptions()), { action: "cancel" });
  assert.deepEqual(await invalid(url, sdkOptions()), { action: "cancel" });

  const controller = new AbortController();
  const sdk = new AbortController();
  const waiting: ElicitationBroker = { requestElicitation: () => new Promise(() => {}) };
  const callback = createElicitationAdapter(waiting, context, { timeoutMs: 10, signal: controller.signal });
  const timedOut = callback(form, sdkOptions());
  t.mock.timers.tick(10);
  assert.deepEqual(await timedOut, { action: "cancel" });
  const abortedBySdk = callback(form, { signal: sdk.signal });
  sdk.abort();
  assert.deepEqual(await abortedBySdk, { action: "cancel" });
  const abortedByRun = callback(form, sdkOptions());
  controller.abort();
  assert.deepEqual(await abortedByRun, { action: "cancel" });
});
