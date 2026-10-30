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
  assert.deepEqual(loadRelaySettings(env({ RELAY_URL: "https://relay.example.com:8443/" })), [{
    url: "https://relay.example.com:8443",
    secret: SECRET,
    deviceId: ID,
    deviceKey: KEY,
  }]);
  assert.equal(loadRelaySettings(env({ RELAY_ENABLED: "on" }))[0]?.deviceId, ID);
  const settings = loadRelaySettings(env({ RELAY_URL: "https://h.example/prefix//" }))[0]!;
  assert.equal(relayBase(settings), `https://h.example/prefix/d/${ID}`);
});

test("RELAY_*：缺设备身份、未配置或关闭时返回空数组", () => {
  for (const key of ["RELAY_DEVICE_ID", "RELAY_DEVICE_KEY"]) {
    assert.deepEqual(loadRelaySettings(env({ [key]: undefined })), [], key);
    assert.deepEqual(loadRelaySettings(env({ [key]: "  " })), [], key);
  }
  assert.deepEqual(loadRelaySettings(env({ RELAY_ENABLED: "off" })), []);
  assert.deepEqual(loadRelaySettings(env({ RELAY_ENABLED: "off", RELAY_URL: "ftp://x", RELAY_URL_3: "bad" })), []);
  assert.deepEqual(loadRelaySettings({}), []);
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

test("loadConfig：单 relay 旧键保持兼容，未配置时 relays 为空", () => {
  assert.equal(loadConfig({ BRIDGE_TOKEN: "t", ...env() }).relays[0]?.url, "https://relay.example.com");
  assert.deepEqual(loadConfig({ BRIDGE_TOKEN: "t" }).relays, []);
});

test("多个 relay：按编号读取，共用身份，密钥可含逗号和竖线", () => {
  const settings = loadRelaySettings(env({ RELAY_SECRET_2: `${SECRET},|`, RELAY_URL_2: "https://second.example.com/" }));
  assert.deepEqual(settings.map((entry) => [entry.url, entry.secret, entry.deviceId, entry.deviceKey]), [
    ["https://relay.example.com", SECRET, ID, KEY],
    ["https://second.example.com", `${SECRET},|`, ID, KEY],
  ]);
});

test("编号空位、不完整、非法或重复地址拒绝启动，并指明 relay 编号", () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ RELAY_URL: undefined }, /relay 1/],
    [{ RELAY_SECRET: " " }, /relay 1/],
    [{ RELAY_URL_2: "https://second.example.com" }, /relay 2/],
    [{ RELAY_SECRET_2: SECRET }, /relay 2/],
    [{ RELAY_URL_2: " " }, /relay 2/],
    [{ RELAY_URL_3: "https://third.example.com", RELAY_SECRET_3: SECRET }, /relay 2/],
    [{ RELAY_URL_2: "http://second.example.com", RELAY_SECRET_2: SECRET }, /relay 2/],
    [{ RELAY_URL_2: "https://second.example.com", RELAY_SECRET_2: "short" }, /relay 2/],
    [{ RELAY_URL_2: "https://RELAY.example.com:443///", RELAY_SECRET_2: SECRET }, /relay 2.*duplicate/],
    [{ RELAY_URL: undefined, RELAY_SECRET: undefined, RELAY_URL_2: "https://second.example.com", RELAY_SECRET_2: SECRET }, /relay 1/],
    [{ RELAY_URL_1: "https://second.example.com" }, /relay 1/],
    [{ RELAY_URL_02: "https://second.example.com" }, /relay 02/],
  ];
  for (const [overrides, message] of cases) {
    assert.throws(() => loadRelaySettings(env(overrides)), message);
    assert.throws(() => loadConfig({ BRIDGE_TOKEN: "t", ...env(overrides) }), ConfigError);
  }
});
