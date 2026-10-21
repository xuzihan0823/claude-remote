import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { setupClaude } from "../src/commands.js";
import { readConfig } from "../src/config.js";
import { claudeCandidates, countProjects, detectClaude, type DetectDeps } from "../src/detect.js";

const base: DetectDeps = {
  env: { PATH: "/usr/bin:/bin" },
  home: "/Users/u",
  loginShellWhich: () => undefined,
  npmPrefix: () => "/opt/npm",
  listDir: (dir) => (dir.endsWith(".nvm/versions/node") ? ["v20.1.0", "v22.12.0", "v22.9.1"] : []),
  version: () => "2.1.220 (Claude Code)",
};

test("候选顺序：PATH → 登录 shell → 官方安装器 → … → nvm（新版本优先）", () => {
  const paths = claudeCandidates({ ...base, loginShellWhich: () => "Welcome!\n/Users/u/.nvm/versions/node/v22.12.0/bin/claude\n" }).map((c) => c.path);
  assert.deepEqual(paths.slice(0, 5), [
    "/usr/bin/claude",
    "/bin/claude",
    "/Users/u/.nvm/versions/node/v22.12.0/bin/claude",
    "/Users/u/.claude/local/claude",
    "/Users/u/.local/bin/claude",
  ]);
  assert.ok(paths.includes("/opt/npm/bin/claude"));
  const nvm = paths.filter((p) => p.includes(".nvm"));
  assert.deepEqual(nvm, [
    "/Users/u/.nvm/versions/node/v22.12.0/bin/claude", // 去重：登录 shell 已给出
    "/Users/u/.nvm/versions/node/v22.9.1/bin/claude",
    "/Users/u/.nvm/versions/node/v20.1.0/bin/claude",
  ]);
});

test("detectClaude：取第一个可执行的候选并带上来源和版本", () => {
  const found = detectClaude({ ...base, isExecutable: (p) => p === "/opt/homebrew/bin/claude" || p === "/opt/npm/bin/claude" });
  assert.deepEqual(found, { path: "/opt/homebrew/bin/claude", source: "Homebrew", version: "2.1.220 (Claude Code)" });
  assert.equal(detectClaude({ ...base, isExecutable: () => false }), undefined);
});

test("setupClaude：探测结果写进配置；已配置且可用就沿用；失效则重新探测", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-detect-"));
  const envFile = join(dir, "config.env");
  const real = join(dir, "claude");
  writeFileSync(real, "#!/bin/sh\necho 9.9.9\n");
  chmodSync(real, 0o755);
  const deps: DetectDeps = { ...base, env: { PATH: dir }, version: () => "9.9.9" };

  assert.equal(setupClaude(envFile, deps)?.source, "当前 PATH");
  assert.equal(readConfig(envFile).find((v) => v.field.alias === "claude")?.value, real);
  assert.deepEqual(setupClaude(envFile, { ...deps, env: { PATH: "" } }), { path: real, source: "已配置", version: "9.9.9" });

  writeFileSync(envFile, "CLAUDE_BIN=/gone/claude\n");
  assert.equal(setupClaude(envFile, deps)?.path, real);
  assert.equal(readConfig(envFile).find((v) => v.field.alias === "claude")?.value, real);
});

test("countProjects：只数目录；不存在返回 undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-proj-"));
  mkdirSync(join(dir, "-a"));
  mkdirSync(join(dir, "-b"));
  writeFileSync(join(dir, "stray.txt"), "");
  assert.equal(countProjects(dir), 2);
  assert.equal(countProjects(join(dir, "missing")), undefined);
});
