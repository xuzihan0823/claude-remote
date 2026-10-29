import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";

const SECRET = "x".repeat(32);

test("缺少或过短的 RELAY_SECRET 拒绝启动", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ RELAY_SECRET: "   " }), ConfigError);
  assert.throws(() => loadConfig({ RELAY_SECRET: "x".repeat(31) }), ConfigError);
});

test("默认值", () => {
  assert.deepEqual(loadConfig({ RELAY_SECRET: SECRET }), {
    secret: SECRET,
    host: "127.0.0.1",
    port: 8790,
    maxStreams: 64,
    maxBodyBytes: 25 * 1024 * 1024,
  });
});

test("覆盖值与 MB 换算", () => {
  const config = loadConfig({
    RELAY_SECRET: SECRET,
    RELAY_HOST: "0.0.0.0",
    RELAY_PORT: "9000",
    RELAY_MAX_STREAMS: "8",
    RELAY_MAX_BODY_MB: "2",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9000);
  assert.equal(config.maxStreams, 8);
  assert.equal(config.maxBodyBytes, 2 * 1024 * 1024);
});

test("非法数值拒绝启动", () => {
  for (const [key, value] of [
    ["RELAY_PORT", "0"],
    ["RELAY_PORT", "70000"],
    ["RELAY_PORT", "abc"],
    ["RELAY_MAX_STREAMS", "-1"],
    ["RELAY_MAX_STREAMS", "1.5"],
    ["RELAY_MAX_BODY_MB", "0"],
  ] as const) {
    assert.throws(() => loadConfig({ RELAY_SECRET: SECRET, [key]: value }), ConfigError, `${key}=${value}`);
  }
});
