import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEffortOptions } from "../src/effort-levels.js";

const ALL = ["low", "medium", "high", "xhigh", "max"];

test("effort levels come from the local Magpie model list, otherwise all levels stay open", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-effort-"));
  const previous = { dir: process.env.CLAUDE_CONFIG_DIR, model: process.env.ANTHROPIC_MODEL };
  process.env.CLAUDE_CONFIG_DIR = root;
  delete process.env.ANTHROPIC_MODEL;
  const settings = (value: unknown) => writeFile(join(root, "settings.json"), JSON.stringify(value));
  const requested: string[] = [];
  let offline = false;
  const request = (async (url: URL) => {
    requested.push(url.href);
    if (offline) throw new Error("offline");
    return Response.json({ data: [
      { id: "Provider/Deep", reasoning: true, reasoning_levels: ["none", "low", "high", "max", "ultra"] },
      { id: "provider/plain", reasoning: false, reasoning_levels: [] },
      { id: "provider/legacy" },
    ] });
  }) as unknown as typeof fetch;
  const gateway = { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_DEFAULT_OPUS_MODEL: "provider/plain" };
  try {
    await settings({ model: "provider/deep[1m]", env: gateway });
    assert.deepEqual(await readEffortOptions(root, undefined, request), { levels: ["low", "high", "max"], verified: true });
    assert.equal(requested.at(-1), "http://127.0.0.1:3425/v1/models");
    assert.deepEqual(await readEffortOptions(root, "opus", request), { levels: ALL, verified: false });
    assert.deepEqual(await readEffortOptions(root, "provider/legacy", request), { levels: ALL, verified: false });
    assert.deepEqual(await readEffortOptions(root, "provider/missing", request), { levels: ALL, verified: false });
    offline = true;
    assert.deepEqual(await readEffortOptions(root, undefined, request), { levels: ALL, verified: false });
    offline = false;

    const before = requested.length;
    await settings({ model: "provider/deep", env: { ANTHROPIC_BASE_URL: "https://remote.example" } });
    assert.deepEqual(await readEffortOptions(root, undefined, request), { levels: ALL, verified: false });
    await settings({ env: gateway });
    assert.deepEqual(await readEffortOptions(root, undefined, request), { levels: ALL, verified: false });
    assert.equal(requested.length, before);
  } finally {
    if (previous.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.dir;
    if (previous.model !== undefined) process.env.ANTHROPIC_MODEL = previous.model;
    await rm(root, { recursive: true, force: true });
  }
});
