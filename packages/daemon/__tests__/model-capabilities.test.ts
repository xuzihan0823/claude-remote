import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelCapabilityService } from "../src/model-capabilities.js";

test("capabilities follow aliases, config changes, gateway levels and unknown states", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-capabilities-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const path = join(root, "settings.json");
  let calls = 0;
  let fail = false;
  const models = [{ value: "default", resolvedModel: "custom/model[1m]", displayName: "Custom", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as const }];
  const query = async () => { calls++; if (fail) throw new Error("offline"); return models.map((m) => ({ ...m, supportedEffortLevels: [...m.supportedEffortLevels] })); };
  let network = 0;
  const request = (async (url: URL) => {
    network++;
    return new Response(JSON.stringify(url.pathname === "/api/hello" ? { name: "magpie" } : { data: [{ id: "custom/model", reasoning: true, reasoning_levels: ["low", "high", "max"] }] }));
  }) as unknown as typeof fetch;
  const service = new ModelCapabilityService(query, request);
  try {
    await writeFile(path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.example", ANTHROPIC_AUTH_TOKEN: "secret-a" } }));
    const first = await service.get(root);
    assert.equal(first.status, "known");
    assert.equal(first.source, "claude");
    assert.equal(network, 0);
    assert.equal(JSON.stringify(first).includes("secret-a"), false);
    assert.deepEqual((await service.get(root, "custom/model")).effortLevels, first.effortLevels);
    assert.equal(calls, 1);
    assert.equal((await service.get(root, "missing")).status, "unknown");
    await writeFile(path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_AUTH_TOKEN: "secret-b" } }));
    const gateway = await service.get(root);
    assert.equal(gateway.source, "magpie");
    assert.deepEqual(gateway.effortLevels, ["low", "high", "max"]);
    assert.notEqual(gateway.revision, first.revision);
    assert.equal(calls, 2);
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.local.json"), JSON.stringify({ alwaysThinkingEnabled: false }));
    assert.equal((await service.get(root)).thinkingEnabled, false);
    fail = true;
    assert.equal((await service.get(root, undefined, true)).status, "unknown");
    fail = false;
    assert.equal((await service.get(root)).status, "known");
    const noLevels = new ModelCapabilityService(async () => [{ value: "default", displayName: "Unknown", description: "", supportsEffort: true }], request);
    assert.equal((await noLevels.get(root)).status, "unknown");
    const unsupported = new ModelCapabilityService(async () => [{ value: "default", displayName: "No", description: "", supportsEffort: false }], async () => { throw new Error("offline"); });
    assert.equal((await unsupported.get(root)).status, "unsupported");
    await writeFile(path, JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } }));
    const beforeLock = calls;
    const locked = await service.get(root);
    assert.equal(locked.status, "unsupported");
    assert.equal(locked.reason, "effort_env_override");
    assert.equal(calls, beforeLock);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
