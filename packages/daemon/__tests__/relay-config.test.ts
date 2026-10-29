import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveDeviceId, generateDeviceKey } from "@claude-remote/relay/protocol";

import { ConfigError, loadConfig, loadRelaySettings, normalizeRelayUrl, relayBase } from "../src/config.js";

const KEY = generateDeviceKey();
const ID = deriveDeviceId(KEY);
const SECRET = "s".repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { RELAY_URL: "https://relay.example.com", RELAY_SECRET: SECRET, RELAY_DEVICE_ID: ID, RELAY_DEVICE_KEY: KEY, ...overrides };
}

test("RELAY_*：四项齐全且未关闭 → 启用；URL 规范化去末尾斜杠", () => {
  assert.deepEqual(loadRelaySettings(env({ RELAY_URL: "https://relay.example.com:8443/" })), {
    url: "https://relay.example.com:8443",
    secret: SECRET,
    deviceId: ID,
    deviceKey: KEY,
  });
  assert.equal(loadRelaySettings(env({ RELAY_ENABLED: "on" }))?.deviceId, ID);
  const settings = loadRelaySettings(env({ RELAY_URL: "https://h.example/prefix//" }));
  assert.equal(settings === undefined ? undefined : relayBase(settings), `https://h.example/prefix/d/${ID}`);
});

test("RELAY_*：缺任一必需值或 RELAY_ENABLED=off → 未启用（不抛错）", () => {
  for (const key of ["RELAY_URL", "RELAY_SECRET", "RELAY_DEVICE_ID", "RELAY_DEVICE_KEY"]) {
    assert.equal(loadRelaySettings(env({ [key]: undefined })), undefined, key);
    assert.equal(loadRelaySettings(env({ [key]: "  " })), undefined, key);
  }
  assert.equal(loadRelaySettings(env({ RELAY_ENABLED: "off" })), undefined);
  // off 时不校验其余值：配置坏了也能先关掉
  assert.equal(loadRelaySettings(env({ RELAY_ENABLED: "off", RELAY_URL: "ftp://x" })), undefined);
  assert.equal(loadRelaySettings({}), undefined);
});

test("RELAY_*：非法值抛 ConfigError，loadConfig 同样拒启", () => {
  const bad: Record<string, string>[] = [
    { RELAY_ENABLED: "yes" },
    { RELAY_URL: "ftp://relay.example.com" },
    { RELAY_URL: "http://relay.example.com" },
    { RELAY_URL: "not a url" },
    { RELAY_URL: "https://relay.example.com/?q=1" },
    { RELAY_URL: "https://user:pw@relay.example.com" },
    { RELAY_SECRET: "short" },
    { RELAY_SECRET: `${"s".repeat(32)} x` },
    { RELAY_SECRET: `${"s".repeat(32)}#x` },
    { RELAY_SECRET: `"${"s".repeat(32)}"` },
    { RELAY_DEVICE_ID: "UPPERCASE-NOT-BASE32" },
    { RELAY_DEVICE_KEY: "too-short" },
    { RELAY_DEVICE_ID: deriveDeviceId(generateDeviceKey()) },
  ];
  for (const overrides of bad) {
    assert.throws(() => loadRelaySettings(env(overrides)), ConfigError, JSON.stringify(overrides));
    assert.throws(() => loadConfig({ BRIDGE_TOKEN: "t", ...env(overrides) }), ConfigError, JSON.stringify(overrides));
  }
});

test("http:// 只允许 localhost / 127.0.0.1", () => {
  assert.equal(normalizeRelayUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(normalizeRelayUrl("http://localhost:8790/"), "http://localhost:8790");
  assert.equal(normalizeRelayUrl("http://192.168.1.2:8790"), undefined);
  assert.equal(normalizeRelayUrl("http://localhost.evil.com"), undefined);
  assert.equal(normalizeRelayUrl("https://relay.example.com"), "https://relay.example.com");
});

test("loadConfig：relay 启用时带 relay，未配置时没有该字段", () => {
  assert.equal(loadConfig({ BRIDGE_TOKEN: "t", ...env() }).relay?.url, "https://relay.example.com");
  assert.equal("relay" in loadConfig({ BRIDGE_TOKEN: "t" }), false);
});
