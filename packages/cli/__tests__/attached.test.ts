import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AttachedDaemon } from "../src/attached.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function make(dir: string, healthy = false) {
  return new AttachedDaemon({
    program: () => ({ args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], workingDir: dir, env: {} }),
    logFile: join(dir, "daemon.log"),
    pidFile: join(dir, "daemon.pid"),
    healthy: async () => healthy,
    waitHealthy: async () => true,
  });
}

test("ensure 拉起子进程、写 pidFile，stop 停掉并清理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-attached-"));
  const d = make(dir);
  assert.equal(await d.ensure(), "started");
  const pid = d.ownedPid as number;
  assert.ok(alive(pid));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "daemon.pid"), "utf8")), { pid, owner: process.pid });
  assert.equal(await d.ensure(), "owned");
  assert.equal(await d.stop(), true);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(join(dir, "daemon.pid")), false);
});

test("已有 daemon 在响应（别人起的）不重复启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-attached-"));
  const d = make(dir, true);
  assert.equal(await d.ensure(), "shared");
  assert.equal(d.ownedPid, undefined);
});

test("孤儿（拉起它的 cr 已退出）被认领；owner 还活着则视为共享", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-attached-"));
  const first = make(dir);
  await first.start();
  const pid = first.ownedPid as number;
  // owner 是一个已退出的 pid → 孤儿
  writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid, owner: 2 ** 22 + 12345 }));
  const second = make(dir);
  assert.equal(await second.ensure(), "adopted");
  assert.equal(second.ownedPid, pid);
  // owner 活着（用测试进程的父进程充当另一个 cr）→ 共享
  writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid, owner: process.ppid }));
  const third = make(dir);
  assert.equal(await third.ensure(), "shared");
  await second.stop();
  assert.equal(alive(pid), false);
});
