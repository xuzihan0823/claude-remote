import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureToken, loadCliEnv, parseDotenv, upsertDotenv } from "../src/env.js";

test("parseDotenv：引号、注释、export 前缀、空值", () => {
  const parsed = parseDotenv(`# c\nBRIDGE_TOKEN="a b#c"\nexport BRIDGE_PORT=8788 # 端口\nEMPTY=\nBAD LINE\nQ='x'`);
  assert.deepEqual(parsed, { BRIDGE_TOKEN: "a b#c", BRIDGE_PORT: "8788", EMPTY: "", Q: "x" });
});

test("upsertDotenv：替换已有（含空值）键，否则追加", () => {
  assert.equal(upsertDotenv("A=1\nBRIDGE_TOKEN=\nB=2\n", "BRIDGE_TOKEN", "t"), "A=1\nBRIDGE_TOKEN=t\nB=2\n");
  assert.equal(upsertDotenv("A=1\n\n", "BRIDGE_TOKEN", "t"), "A=1\nBRIDGE_TOKEN=t\n");
  assert.equal(upsertDotenv("", "BRIDGE_TOKEN", "t"), "BRIDGE_TOKEN=t\n");
});

function repo(dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cr-env-"));
  if (dotenv !== undefined) writeFileSync(join(dir, ".env"), dotenv);
  return dir;
}

test("token 优先级：环境变量 > .env > Keychain", () => {
  const dir = repo("BRIDGE_TOKEN=from-file\nBRIDGE_PORT=8788\n");
  const keychain = (): string => "from-keychain";
  const a = loadCliEnv({ env: { CLAUDE_REMOTE_REPO: dir, BRIDGE_TOKEN: "from-env" }, keychain });
  assert.equal(a.token, "from-env");
  assert.equal(a.tokenSource, "env");
  const b = loadCliEnv({ env: { CLAUDE_REMOTE_REPO: dir }, keychain });
  assert.equal(b.token, "from-file");
  assert.equal(b.port, 8788);
  assert.equal(b.baseUrl, "http://127.0.0.1:8788");
  const c = loadCliEnv({ env: { CLAUDE_REMOTE_REPO: repo() }, keychain });
  assert.equal(c.token, "from-keychain");
  assert.equal(c.tokenSource, "keychain");
  const d = loadCliEnv({ env: { CLAUDE_REMOTE_REPO: repo() }, keychain: () => undefined });
  assert.equal(d.token, undefined);
  assert.equal(d.port, 8787);
});

test("BRIDGE_HOST：0.0.0.0 走 loopback；具体 IP 直连", () => {
  const k = (): undefined => undefined;
  assert.equal(loadCliEnv({ env: { CLAUDE_REMOTE_REPO: repo("BRIDGE_HOST=0.0.0.0\n") }, keychain: k }).baseUrl, "http://127.0.0.1:8787");
  assert.equal(loadCliEnv({ env: { CLAUDE_REMOTE_REPO: repo("BRIDGE_HOST=100.64.0.10\n") }, keychain: k }).baseUrl, "http://100.64.0.10:8787");
  assert.throws(() => loadCliEnv({ env: { CLAUDE_REMOTE_REPO: repo(), BRIDGE_PORT: "99999" }, keychain: k }));
});

test("ensureToken：已有不动；Keychain 迁移；否则生成并写 0600", () => {
  const kept = repo("BRIDGE_TOKEN=keep\n");
  assert.equal(ensureToken(loadCliEnv({ env: { CLAUDE_REMOTE_REPO: kept }, keychain: () => "k" })).action, "kept");

  const migrate = repo("BRIDGE_PORT=8788\nBRIDGE_TOKEN=\n");
  const r = ensureToken(loadCliEnv({ env: { CLAUDE_REMOTE_REPO: migrate }, keychain: () => "legacy" }));
  assert.deepEqual(r, { token: "legacy", action: "migrated" });
  assert.equal(readFileSync(join(migrate, ".env"), "utf8"), "BRIDGE_PORT=8788\nBRIDGE_TOKEN=legacy\n");

  const fresh = repo();
  const g = ensureToken(loadCliEnv({ env: { CLAUDE_REMOTE_REPO: fresh }, keychain: () => undefined }));
  assert.equal(g.action, "generated");
  assert.ok(g.token.length >= 40);
  assert.equal(statSync(join(fresh, ".env")).mode & 0o777, 0o600);
});

test("package 模式：配置与数据在 ~/.claude-remote（CLAUDE_REMOTE_HOME 可改），daemon 入口在包内 dist/", () => {
  const home = mkdtempSync(join(tmpdir(), "cr-pkg-home-"));
  const install = { mode: "package" as const, root: "/usr/local/lib/node_modules/x" };
  const a = loadCliEnv({ env: {}, home, install, keychain: () => undefined });
  assert.equal(a.mode, "package");
  assert.equal(a.envFile, join(home, ".claude-remote", "config.env"));
  assert.equal(a.daemonEntry, "/usr/local/lib/node_modules/x/dist/daemon.js");
  assert.equal(a.token, undefined);
  const b = loadCliEnv({ env: { CLAUDE_REMOTE_HOME: join(home, "alt") }, home, install, keychain: () => undefined });
  assert.equal(b.envFile, join(home, "alt", "config.env"));
  // setup 写 token 时自动建目录（权限 700），文件权限 600
  const { action } = ensureToken(a);
  assert.equal(action, "generated");
  assert.equal(statSync(a.envFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".claude-remote")).mode & 0o777, 0o700);
});
