import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ActivityTracker } from "../src/watch/activity.js";
import { CliExitReleaser, readLiveCliSessions } from "../src/watch/cli-presence.js";

function setup() {
  let now = 0;
  let live = new Set<string>();
  const tracker = new ActivityTracker({ cooldownMs: 120_000, now: () => now });
  const releaser = new CliExitReleaser({ tracker, readLive: async () => live, now: () => now });
  return {
    tracker,
    releaser,
    setLive: (ids: string[]) => { live = new Set(ids); },
    advance: (ms: number) => { now += ms; },
    dispose: () => tracker.dispose(),
  };
}

test("终端进程退出 → 立刻解除 terminal-driving，退出时的收尾写入不再占用", async () => {
  const t = setup();
  t.setLive(["s1"]);
  t.tracker.noteWrite("s1");
  await t.releaser.tick();
  assert.equal(t.tracker.getStatus("s1"), "terminal-driving");

  t.setLive([]);
  t.advance(2_000);
  await t.releaser.tick();
  assert.equal(t.tracker.getStatus("s1"), "idle");

  t.advance(500);
  t.tracker.noteWrite("s1");
  assert.equal(t.tracker.getStatus("s1"), "idle");
  t.dispose();
});

test("退出写入晚于宽限期到达 → 下一轮仍会释放", async () => {
  const t = setup();
  t.setLive(["s1"]);
  await t.releaser.tick();
  t.setLive([]);
  t.advance(5_000);
  t.tracker.noteWrite("s1");
  await t.releaser.tick();
  assert.equal(t.tracker.getStatus("s1"), "idle");
  t.dispose();
});

test("从未见过登记（老版本 CLI）→ 不释放，退回 cooldown 判定", async () => {
  const t = setup();
  t.tracker.noteWrite("s1");
  await t.releaser.tick();
  assert.equal(t.tracker.getStatus("s1"), "terminal-driving");
  t.dispose();
});

test("终端仍开着 → 保持 terminal-driving", async () => {
  const t = setup();
  t.setLive(["s1"]);
  t.tracker.noteWrite("s1");
  await t.releaser.tick();
  t.advance(30_000);
  await t.releaser.tick();
  assert.equal(t.tracker.getStatus("s1"), "terminal-driving");
  t.dispose();
});

test("readLiveCliSessions 只返回存活进程的 sessionId，坏文件忽略", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-sessions-"));
  try {
    await writeFile(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "alive" }));
    await writeFile(join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "dead" }));
    await writeFile(join(dir, "3.json"), "{ half");
    await writeFile(join(dir, "1.abc.key"), "x");
    const live = await readLiveCliSessions(dir, (pid) => pid === 1);
    assert.deepEqual([...live], ["alive"]);
    assert.equal((await readLiveCliSessions(join(dir, "missing"))).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
