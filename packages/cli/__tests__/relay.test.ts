import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadRelaySettings } from "@claude-remote/daemon/config";
import { deriveDeviceId } from "@claude-remote/relay/protocol";

import { ApiError, type ConnectInfo, type RelayStatus } from "../src/api.js";
import { configuredRelayBases, pairInfo } from "../src/daemon-control.js";
import { parseDotenv } from "../src/env.js";
import { parseRelayUrl, readRelayFile, relayLine, snapshotRelayLine, type RelayDeps, type RestartResult, runRelay } from "../src/relay.js";

const SECRET = "x".repeat(40);
const URL_ = "https://relay.example.com";

function envFile(text = "BRIDGE_TOKEN=t\n# 注释\n"): string {
  const file = join(mkdtempSync(join(tmpdir(), "cr-relay-")), ".env");
  writeFileSync(file, text);
  return file;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Harness {
  deps: RelayDeps;
  lines: string[];
  fetched: string[];
  restarts: number;
  polls: number;
}

/** connectInfo 依次返回 statuses（用完后重复最后一个）；时钟随 sleep 前进。 */
function harness(
  file: string,
  opts: { statuses?: Array<RelayStatus | RelayStatus[] | Error>; restart?: RestartResult; fetch?: typeof fetch } = {},
): Harness {
  let clock = 0;
  const h: Harness = { deps: undefined as unknown as RelayDeps, lines: [], fetched: [], restarts: 0, polls: 0 };
  const statuses = opts.statuses;
  h.deps = {
    envFile: file,
    out: (line) => h.lines.push(line),
    fetch:
      opts.fetch ??
      (async (input) => {
        h.fetched.push(String(input));
        return json(200, { ok: true });
      }),
    restart: async () => {
      h.restarts += 1;
      return opts.restart ?? { kind: "restarted" };
    },
    connectInfo: async (): Promise<ConnectInfo> => {
      const next = statuses?.[Math.min(h.polls, statuses.length - 1)];
      h.polls += 1;
      if (next instanceof Error) throw next;
      const entries = readRelayFile(file).relays;
      const relays = next === undefined ? entries.map((entry) => ({ state: "connected" as const, base: entry.base!, since: 0 }))
        : (Array.isArray(next) ? next : [next]).map((status) => ({ ...status, base: status.base ?? entries[0]?.base ?? `${URL_}/d/x` }));
      return { bases: [], relays };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return h;
}

test("parseRelayUrl：https 规范化；http 仅限本机；拒绝参数、凭据和其他协议", () => {
  assert.equal(parseRelayUrl("https://relay.example.com/"), URL_);
  assert.equal(parseRelayUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  for (const bad of ["http://relay.example.com", "ftp://relay.example.com", "relay.example.com", "https://a.com/?k=1", "https://u:p@a.com"]) {
    assert.throws(() => parseRelayUrl(bad), /relay 地址不合法/, bad);
  }
});

test("relay add：检查 /healthz，写入 RELAY_*（600 权限、保留其他行），daemon 能读出同样的配置", async () => {
  const file = envFile();
  const h = harness(file);
  assert.equal(await runRelay(["add", `${URL_}/`, SECRET], h.deps), 0);
  assert.deepEqual(h.fetched, [`${URL_}/healthz`]);
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("BRIDGE_TOKEN=t\n# 注释\n"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const dotenv = parseDotenv(text);
  assert.equal(dotenv.RELAY_ENABLED, "on");
  assert.equal(dotenv.RELAY_DEVICE_ID, deriveDeviceId(dotenv.RELAY_DEVICE_KEY!));
  assert.deepEqual(loadRelaySettings(dotenv), [{
    url: URL_,
    secret: SECRET,
    deviceId: dotenv.RELAY_DEVICE_ID,
    deviceKey: dotenv.RELAY_DEVICE_KEY,
  }]);
  assert.equal(h.restarts, 1);
  assert.ok(h.lines.some((l) => l.startsWith(`✓ 已连接 relay，手机地址 ${URL_}/d/${dotenv.RELAY_DEVICE_ID}`)));
});

test("relay add 追加地址、沿用设备私钥和 ID；同地址更新密钥不重复添加", async () => {
  const file = envFile();
  await runRelay(["add", URL_, SECRET], harness(file).deps);
  const first = parseDotenv(readFileSync(file, "utf8"));
  const h = harness(file);
  assert.equal(await runRelay(["add", "https://other.example.com", "y".repeat(32)], h.deps), 0);
  const second = parseDotenv(readFileSync(file, "utf8"));
  assert.equal(second.RELAY_DEVICE_KEY, first.RELAY_DEVICE_KEY);
  assert.equal(second.RELAY_DEVICE_ID, first.RELAY_DEVICE_ID);
  assert.equal(second.RELAY_URL, URL_);
  assert.equal(second.RELAY_SECRET, SECRET);
  assert.equal(second.RELAY_URL_2, "https://other.example.com");
  assert.equal(second.RELAY_SECRET_2, "y".repeat(32));
  assert.ok(h.lines.some((l) => l.includes("沿用已有设备私钥")));
  assert.ok(h.lines.some((l) => l.includes("如需替换")));
  await runRelay(["add", `${URL_}/`, "z".repeat(32)], harness(file).deps);
  const updated = parseDotenv(readFileSync(file, "utf8"));
  assert.equal(updated.RELAY_SECRET, "z".repeat(32));
  assert.equal(updated.RELAY_SECRET_2, second.RELAY_SECRET_2);
  assert.equal(updated.RELAY_URL_3, undefined);
  assert.equal(updated.RELAY_DEVICE_ID, first.RELAY_DEVICE_ID);
});

test("relay add 校验失败时不写文件、不重启", async () => {
  const cases: Array<[string[], RegExp, typeof fetch | undefined]> = [
    [["add", "http://relay.example.com", SECRET], /relay 地址不合法/, undefined],
    [["add", URL_, "short"], /至少 32 个字符/, undefined],
    [["add", URL_, `${"x".repeat(32)} 空格`], /至少 32 个字符/, undefined],
    [["add", URL_], /用法/, undefined],
    [["add", URL_, SECRET], /连不上 relay/, async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))],
    [["add", URL_, SECRET], /不像 claude-remote relay（\/healthz 返回 HTTP 200）/, async () => new Response("<html>")],
    [["add", URL_, SECRET], /HTTP 502/, async () => json(502, { ok: false })],
  ];
  for (const [args, message, fetchImpl] of cases) {
    const file = envFile();
    const h = harness(file, fetchImpl === undefined ? {} : { fetch: fetchImpl });
    await assert.rejects(runRelay(args, h.deps), message, args.join(" "));
    assert.equal(readFileSync(file, "utf8"), "BRIDGE_TOKEN=t\n# 注释\n");
    assert.equal(h.restarts, 0);
  }
});

test("relay add：密钥错误立即报告，不等满 15 秒", async () => {
  const h = harness(envFile(), { statuses: [{ state: "connecting", since: 0 }, { state: "error", error: "auth", since: 0 }] });
  assert.equal(await runRelay(["add", URL_, SECRET], h.deps), 1);
  assert.equal(h.polls, 2);
  assert.match(h.lines.at(-1) ?? "", /✗ .*relay 密钥错误/);
});

test("relay add：15 秒内连不上 → 超时提示；暂时性错误（unreachable）会继续等", async () => {
  const pending = harness(envFile(), { statuses: [{ state: "connecting", since: 0 }] });
  assert.equal(await runRelay(["add", URL_, SECRET], pending.deps), 1);
  assert.equal(pending.polls, 31);
  assert.match(pending.lines.at(-1) ?? "", /15 秒内没有连上目标 relay/);

  const flaky = harness(envFile(), {
    statuses: [{ state: "error", error: "unreachable", since: 0 }, { state: "connected", since: 0 }],
  });
  assert.equal(await runRelay(["add", URL_, SECRET], flaky.deps), 0);
  assert.equal(flaky.polls, 2);
});

test("relay add：daemon 不归 launchd 管时只提示如何生效；旧 daemon（404）提示升级", async () => {
  const skipped = harness(envFile(), { restart: { kind: "skipped", note: "在 cr 里按 r 重启" } });
  assert.equal(await runRelay(["add", URL_, SECRET], skipped.deps), 0);
  assert.equal(skipped.polls, 0);
  assert.ok(skipped.lines.includes("在 cr 里按 r 重启"));

  const old = harness(envFile(), { statuses: [new ApiError(404, "not_found")] });
  assert.equal(await runRelay(["add", URL_, SECRET], old.deps), 1);
  assert.match(old.lines.at(-1) ?? "", /版本过旧/);
});

test("relay off / on 只改开关、保留其余配置；未配置时报错", async () => {
  const file = envFile();
  await assert.rejects(runRelay(["off"], harness(file).deps), /还没有配置 relay/);
  await runRelay(["add", URL_, SECRET], harness(file).deps);
  const before = parseDotenv(readFileSync(file, "utf8"));

  const off = harness(file, { statuses: [{ state: "connected", since: 0 }, { state: "disabled", since: 0 }] });
  assert.equal(await runRelay(["off"], off.deps), 0);
  const afterOff = parseDotenv(readFileSync(file, "utf8"));
  assert.deepEqual(afterOff, { ...before, RELAY_ENABLED: "off" });
  assert.deepEqual(loadRelaySettings(afterOff), []);
  assert.equal(off.polls, 2);
  assert.match(off.lines.at(-1) ?? "", /已断开指定 relay/);

  assert.equal(await runRelay(["on"], harness(file).deps), 0);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), before);
});

test("relay remove 删除全部 RELAY_*（含设备私钥），其他行不动；再 add 得到新设备 ID", async () => {
  const file = envFile();
  await runRelay(["add", URL_, SECRET], harness(file).deps);
  const oldId = parseDotenv(readFileSync(file, "utf8")).RELAY_DEVICE_ID;
  const h = harness(file, { statuses: [{ state: "disabled", since: 0 }] });
  assert.equal(await runRelay(["remove"], h.deps), 0);
  assert.equal(readFileSync(file, "utf8"), "BRIDGE_TOKEN=t\n# 注释\n");
  assert.equal(h.restarts, 1);

  const again = harness(file);
  assert.equal(await runRelay(["remove"], again.deps), 0);
  assert.equal(again.restarts, 0);
  assert.match(again.lines[0] ?? "", /未配置/);

  await runRelay(["add", URL_, SECRET], harness(file).deps);
  assert.notEqual(parseDotenv(readFileSync(file, "utf8")).RELAY_DEVICE_ID, oldId);
});

test("relay status：显示配置与 daemon 报告的状态；daemon 不通时说明", async () => {
  const file = envFile();
  await runRelay(["add", URL_, SECRET], harness(file).deps);
  const id = parseDotenv(readFileSync(file, "utf8")).RELAY_DEVICE_ID;
  const live = harness(file, { statuses: [{ state: "error", error: "replaced", since: 0 }] });
  assert.equal(await runRelay(["status"], live.deps), 0);
  assert.ok(live.lines.includes(`手机地址 ${URL_}/d/${id}`));
  assert.match(live.lines.at(-1) ?? "", /同一设备 ID 在别处接入/);
  assert.equal(live.restarts, 0);

  const down = harness(file, { statuses: [new Error("fetch failed")] });
  await runRelay([], down.deps);
  assert.match(down.lines.at(-1) ?? "", /已配置，daemon 未运行/);

  assert.equal(await runRelay(["bogus"], harness(file).deps), 2);
});

test("add 只等目标 relay：其他 relay 错误不拖累，也不能用第一台成功冒充第二台成功", async () => {
  const file = envFile();
  await runRelay(["add", URL_, SECRET], harness(file).deps);
  const id = parseDotenv(readFileSync(file, "utf8")).RELAY_DEVICE_ID;
  const other = "https://second.example.com";
  const firstBase = `${URL_}/d/${id}`;
  const secondBase = `${other}/d/${id}`;
  const h = harness(file, { statuses: [
    [{ state: "connected", base: firstBase }, { state: "connecting", base: secondBase }],
    [{ state: "error", error: "auth", base: firstBase }, { state: "connected", base: secondBase }],
  ] });
  assert.equal(await runRelay(["add", other, SECRET], h.deps), 0);
  assert.equal(h.polls, 2);
  const bad = harness(file, { statuses: [[{ state: "connected", base: firstBase }, { state: "error", error: "auth", base: secondBase }]] });
  assert.equal(await runRelay(["add", other, SECRET], bad.deps), 1);
  assert.equal(bad.polls, 1);
  assert.match(bad.lines.at(-1)!, /second\.example\.com.*密钥错误/);
});

test("remove 指定地址重排编号、保留私钥；多项时无参数报错并列出地址", async () => {
  const file = envFile();
  const urls = [URL_, "https://second.example.com", "https://third.example.com"];
  for (const url of urls) await runRelay(["add", url, SECRET], harness(file).deps);
  const before = parseDotenv(readFileSync(file, "utf8"));
  const h = harness(file);
  await assert.rejects(runRelay(["remove"], h.deps), (error: Error) => urls.every((url) => error.message.includes(url)));
  assert.equal(h.restarts, 0);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), before);
  await assert.rejects(runRelay(["remove", "https://missing.example.com"], h.deps), /未配置 relay/);
  assert.equal(await runRelay(["remove", `${urls[1]}/`], h.deps), 0);
  const after = parseDotenv(readFileSync(file, "utf8"));
  assert.equal(after.RELAY_URL, urls[0]);
  assert.equal(after.RELAY_URL_2, urls[2]);
  assert.equal(after.RELAY_URL_3, undefined);
  assert.equal(after.RELAY_SECRET_3, undefined);
  assert.equal(after.RELAY_DEVICE_ID, before.RELAY_DEVICE_ID);
  assert.equal(after.RELAY_DEVICE_KEY, before.RELAY_DEVICE_KEY);
  assert.equal(loadRelaySettings(after).length, 2);
  await runRelay(["remove", urls[0]!], harness(file).deps);
  assert.equal(readRelayFile(file).relays[0]?.url, urls[2]);
  await runRelay(["remove", urls[2]!], harness(file).deps);
  const empty = parseDotenv(readFileSync(file, "utf8"));
  assert.equal(empty.RELAY_DEVICE_KEY, before.RELAY_DEVICE_KEY);
  assert.deepEqual(loadRelaySettings(empty), []);
  await runRelay(["add", urls[0]!, SECRET], harness(file).deps);
  assert.equal(parseDotenv(readFileSync(file, "utf8")).RELAY_DEVICE_ID, before.RELAY_DEVICE_ID);
});

test("remove --all 动态清理全部编号和私钥，on/off 保留多个配置", async () => {
  const file = envFile();
  for (const url of [URL_, "https://second.example.com"]) await runRelay(["add", url, SECRET], harness(file).deps);
  const before = parseDotenv(readFileSync(file, "utf8"));
  await runRelay(["off"], harness(file, { statuses: [[]] }).deps);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), { ...before, RELAY_ENABLED: "off" });
  await runRelay(["on"], harness(file).deps);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), before);
  assert.equal(await runRelay(["remove", "--all"], harness(file).deps), 0);
  assert.equal(readFileSync(file, "utf8"), "BRIDGE_TOKEN=t\n# 注释\n");
});

test("状态逐条显示地址、错误和汇总；旧 daemon 缺 relays 时显示尚未加载", async () => {
  const file = envFile();
  for (const url of [URL_, "https://second.example.com"]) await runRelay(["add", url, SECRET], harness(file).deps);
  const config = readRelayFile(file);
  const statuses: RelayStatus[] = config.relays.map((entry, index) => ({ base: entry.base!, state: index === 0 ? "connected" : "error", ...(index === 1 ? { error: "auth" } : {}) }));
  const h = harness(file, { statuses: [statuses] });
  await runRelay(["status"], h.deps);
  assert.ok(config.relays.every((entry) => h.lines.includes(`手机地址 ${entry.base}`)));
  assert.match(relayLine(statuses, config), /1\/2 已连接.*second\.example\.com.*密钥错误/);
  assert.equal(relayLine(statuses.map((status) => ({ ...status, state: "connected" })), config), "2/2 已连接");
  const old = harness(file);
  old.deps.connectInfo = async () => ({ bases: [], relay: { state: "connected" } }) as unknown as ConnectInfo;
  await runRelay(["status"], old.deps);
  assert.match(old.lines.at(-1)!, /配置已写入，daemon 尚未加载/);
  assert.match(snapshotRelayLine({ reachable: true, connect: await old.deps.connectInfo() }, config), /尚未加载/);
  assert.equal(await runRelay(["add", URL_, SECRET], old.deps), 1);
  assert.match(old.lines.at(-1)!, /配置已写入，daemon 尚未加载/);
});

test("CLI 离线配对包含所有 relay；尚未重启时摘要提示配置尚未加载", async () => {
  const file = envFile();
  for (const url of [URL_, "https://second.example.com"]) await runRelay(["add", url, SECRET], harness(file).deps);
  const config = readRelayFile(file);
  const bases = config.relays.map((entry) => entry.base!);
  assert.deepEqual(configuredRelayBases(file), bases);
  const info = pairInfo({ env: { token: "t", port: 8787, envFile: file } } as Parameters<typeof pairInfo>[0]);
  assert.deepEqual(info?.bases.slice(-2), bases);
  const statuses: RelayStatus[] = bases.map((base) => ({ state: "connected", base }));
  assert.match(relayLine(statuses, { ...config, enabled: false }), /尚未加载/);
  assert.match(relayLine(statuses, { ...config, relays: [config.relays[0]!] }), /尚未加载/);
  assert.match(relayLine([statuses[0]!], config), /1\/2 已连接.*尚未加载/);
});
