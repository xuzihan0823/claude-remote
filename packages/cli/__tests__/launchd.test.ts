import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseEtime } from "../src/daemon-control.js";
import { DAEMON_LABEL, Launchd, packageProgram, parseLaunchctlPrint, renderPlist, repoProgram, type Exec } from "../src/launchd.js";

test("renderPlist：转义路径、KeepAlive、日志路径", () => {
  const xml = renderPlist({ program: repoProgram("/r<1>&b"), logFile: "/l/daemon.log" });
  assert.match(xml, /<string>\/r&lt;1&gt;&amp;b\/scripts\/launchd\/run-daemon\.sh<\/string>/);
  assert.match(xml, /<key>CLAUDE_REMOTE_REPO<\/key>\s*<string>\/r&lt;1&gt;&amp;b<\/string>/);
  assert.match(xml, new RegExp(`<string>${DAEMON_LABEL}</string>`));
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.equal((xml.match(/\/l\/daemon\.log/g) ?? []).length, 2);
});

test("packageProgram：node 直接跑 dist/daemon.js，PATH 带上 claude 与 node 目录", () => {
  const p = packageProgram({
    nodePath: "/Users/u/.nvm/versions/node/v22.12.0/bin/node",
    daemonEntry: "/usr/local/lib/node_modules/x/dist/daemon.js",
    dataDir: "/Users/u/.claude-remote",
    envFile: "/Users/u/.claude-remote/config.env",
    claudeBin: "/Users/u/.claude/local/claude",
    home: "/Users/u",
  });
  assert.deepEqual(p.args, ["/Users/u/.nvm/versions/node/v22.12.0/bin/node", "/usr/local/lib/node_modules/x/dist/daemon.js"]);
  assert.equal(p.workingDir, "/Users/u/.claude-remote");
  assert.equal(p.env.CLAUDE_REMOTE_ENV_FILE, "/Users/u/.claude-remote/config.env");
  const path = (p.env.PATH ?? "").split(":");
  assert.deepEqual(path.slice(0, 3), ["/Users/u/.claude/local", "/Users/u/.nvm/versions/node/v22.12.0/bin", "/Users/u/.local/bin"]);
  assert.ok(path.includes("/usr/bin"));
  const xml = renderPlist({ program: p, logFile: "/l" });
  assert.doesNotMatch(xml, /zsh/);
});

test("parseLaunchctlPrint：取顶层 state/pid/runs/last exit code", () => {
  const out = parseLaunchctlPrint(`gui/501/com.claude-remote.daemon = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /bin/zsh\n\truns = 3\n\tpid = 4312\n\tlast exit code = 1\n}`);
  assert.deepEqual(out, { state: "running", pid: 4312, lastExitCode: "1", runs: 3 });
  assert.deepEqual(parseLaunchctlPrint("state = not running\nlast exit code = (never exited)"), {
    state: "not running", lastExitCode: "(never exited)",
  });
});

test("parseEtime", () => {
  assert.equal(parseEtime("  05:07"), 307_000);
  assert.equal(parseEtime("01:00:00"), 3_600_000);
  assert.equal(parseEtime("3-04:00:00\n"), (3 * 24 + 4) * 3_600_000);
  assert.equal(parseEtime("garbage"), undefined);
});

/** 模拟 launchctl：记录调用、维护 loaded 状态。 */
function fakeLaunchctl(): { exec: Exec; calls: string[]; loaded: { v: boolean } } {
  const calls: string[] = [];
  const loaded = { v: false };
  const exec: Exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd !== "launchctl") throw new Error("unexpected");
    const [sub] = args;
    if (sub === "print") {
      if (!loaded.v) throw new Error("not loaded");
      return "state = running\npid = 42\nruns = 1\n";
    }
    if (sub === "bootstrap") loaded.v = true;
    if (sub === "bootout") loaded.v = false;
    return "";
  };
  return { exec, calls, loaded };
}

test("Launchd：up 写 plist 并 bootstrap；重复 up 不重载；down 卸载并 disable；uninstall 删 plist", async () => {
  const home = mkdtempSync(join(tmpdir(), "cr-home-"));
  const fake = fakeLaunchctl();
  const l = new Launchd({ program: () => repoProgram("/repo"), logFile: join(home, "logs/daemon.log"), exec: fake.exec, home, uid: 501, sleep: async () => {} });

  const first = await l.up();
  assert.deepEqual(first, { changed: true, alreadyRunning: false });
  assert.ok(existsSync(l.plistPath));
  assert.match(readFileSync(l.plistPath, "utf8"), /\/repo\/scripts\/launchd\/run-daemon\.sh/);
  assert.ok(fake.calls.includes(`launchctl bootstrap gui/501 ${l.plistPath}`));
  assert.ok(fake.calls.includes(`launchctl enable gui/501/${DAEMON_LABEL}`));

  const second = await l.up();
  assert.deepEqual(second, { changed: false, alreadyRunning: true });

  assert.deepEqual(l.status(), { loaded: true, installed: true, state: "running", pid: 42, runs: 1 });

  await l.restart();
  assert.ok(fake.calls.includes(`launchctl kickstart -k gui/501/${DAEMON_LABEL}`));

  await l.down();
  assert.equal(fake.loaded.v, false);
  assert.ok(fake.calls.includes(`launchctl disable gui/501/${DAEMON_LABEL}`));
  assert.deepEqual(l.status(), { loaded: false, installed: true });

  await l.restart(); // 未加载时 restart 等同 up
  assert.equal(fake.loaded.v, true);

  await l.uninstall();
  assert.equal(existsSync(l.plistPath), false);
  assert.equal(fake.loaded.v, false);
});
