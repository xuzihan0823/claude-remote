import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findField, readConfig, removeDotenvKey, rotateToken, setConfig } from "../src/config.js";
import { parseDotenv } from "../src/env.js";

function envFile(text = ""): string {
  const file = join(mkdtempSync(join(tmpdir(), "cr-config-")), ".env");
  writeFileSync(file, text);
  return file;
}

test("findField：别名和环境变量名都能找到", () => {
  assert.equal(findField("port")?.key, "BRIDGE_PORT");
  assert.equal(findField("PERMISSION_TIMEOUT_MS")?.alias, "timeout");
  assert.equal(findField("nope"), undefined);
});

test("setConfig：校验、秒→毫秒、保留其他行、权限 600", () => {
  const file = envFile("# 注释\nBRIDGE_TOKEN=t\nBRIDGE_PORT=8787\n");
  setConfig(file, findField("port")!, "8790");
  setConfig(file, findField("timeout")!, " 90 ");
  setConfig(file, findField("bark")!, "https://api.day.app/KEY");
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("# 注释\nBRIDGE_TOKEN=t\nBRIDGE_PORT=8790\n"));
  assert.deepEqual(
    { port: parseDotenv(text).BRIDGE_PORT, timeout: parseDotenv(text).PERMISSION_TIMEOUT_MS, bark: parseDotenv(text).BARK_URL },
    { port: "8790", timeout: "90000", bark: "https://api.day.app/KEY" },
  );
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const timeout = readConfig(file).find((v) => v.field.alias === "timeout");
  assert.equal(timeout?.value, "90");

  assert.throws(() => setConfig(file, findField("port")!, "0"), /端口/);
  assert.throws(() => setConfig(file, findField("port")!, "70000"), /1–65535/);
  assert.throws(() => setConfig(file, findField("bark")!, "api.day.app"), /URL/);
  assert.throws(() => setConfig(file, findField("host")!, "bad host!"), /IP 地址或主机名/);
  assert.throws(() => setConfig(file, findField("claude")!, "claude"), /绝对路径/);
  assert.throws(() => setConfig(file, findField("timeout")!, "1.5"), /正整数/);
  assert.equal(parseDotenv(readFileSync(file, "utf8")).BRIDGE_PORT, "8790"); // 失败不改文件
});

test("setConfig 空值 = 恢复默认（删除该行）；removeDotenvKey 删除所有同名行", () => {
  const file = envFile("BRIDGE_TOKEN=t\nBRIDGE_HOST=0.0.0.0\n");
  setConfig(file, findField("host")!, "");
  assert.equal(readFileSync(file, "utf8"), "BRIDGE_TOKEN=t\n");
  assert.equal(readConfig(file).find((v) => v.field.alias === "host")?.value, undefined);
  assert.equal(removeDotenvKey("A=1\nexport B=2\nB=3\n", "B"), "A=1\n");
  assert.equal(removeDotenvKey("B=1\n", "B"), "");
});

test("rotateToken：替换 token，其余不动", () => {
  const file = envFile("BRIDGE_TOKEN=old\nBRIDGE_PORT=1\n");
  const token = rotateToken(file);
  assert.notEqual(token, "old");
  assert.ok(token.length >= 40);
  assert.equal(readFileSync(file, "utf8"), `BRIDGE_TOKEN=${token}\nBRIDGE_PORT=1\n`);
});
