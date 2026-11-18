import { CONFIG_FIELDS } from "../src/config.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { render } from "ink-testing-library";

import type { ApprovalCard, Decision, ServerFrame, SessionSummary } from "../src/api.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfig, rotateToken, setConfig } from "../src/config.js";
import { configuredRelayBases, type DaemonSnapshot } from "../src/daemon-control.js";
import { readRelayFile, runRelay } from "../src/relay.js";
import { App, type TuiExit } from "../src/tui/App.js";
import type { TuiDeps } from "../src/tui/deps.js";

const now = Date.now();
const sessions: SessionSummary[] = [
  { sessionId: "a1b2c3d4-0000-4000-8000-000000000001", cwd: "/Users/mac/code/claude-remote", projectDirName: "x",
    title: "修复 WS 半开连接检测", lastPreview: "", lastActiveAt: now - 3_600_000, sizeBytes: 1, status: "idle" },
  { sessionId: "e5f6a7b8-0000-4000-8000-000000000002", cwd: "/Users/mac/code/pi-remote", projectDirName: "y",
    title: "Relay 重连丢消息", lastPreview: "", lastActiveAt: now - 60_000, sizeBytes: 1, status: "daemon-driving" },
];
const card: ApprovalCard = {
  interactionId: "int-1", sessionId: sessions[1]!.sessionId, kind: "approval", toolName: "Bash",
  input: { command: "rm -rf build" }, prompt: "Run Bash?", expiresAt: now + 300_000,
};

function fakeDeps(overrides: Partial<TuiDeps> = {}) {
  const calls = { decide: [] as Array<[string, Decision]>, search: [] as Array<[string, boolean]>, sent: [] as string[], restarts: 0 };
  const envFile = join(mkdtempSync(join(tmpdir(), "cr-tui-")), ".env");
  writeFileSync(envFile, "BRIDGE_TOKEN=old-token\n");
  let push: ((f: ServerFrame) => void) | undefined;
  const snap: DaemonSnapshot = {
    launchd: { loaded: true, installed: true, pid: 1 }, reachable: true, unauthorized: false,
    version: "0.1.0", claudeCliVersion: "2.1.0", uptimeMs: 3 * 86_400_000, sessions, pending: [card],
  };
  const deps: TuiDeps = {
    baseUrl: "http://127.0.0.1:8787",
    api: {
      search: async (q: string, full?: boolean) => {
        calls.search.push([q, full === true]);
        return { results: [{ ...sessions[1]!, match: { field: "content", snippet: "…git filter-repo…", seq: 3 } }], truncated: false };
      },
      messages: async () => ({ messages: [{ seq: 1, blockIndex: 0, uuid: "u", role: "user", kind: "text", text: "你好" }], hasMore: false }),
      send: async (_id: string, text: string) => {
        calls.sent.push(text);
        return { runId: "r" };
      },
      abort: async () => ({}),
      decide: async (id: string, d: Decision) => {
        calls.decide.push([id, d]);
        return { status: d.type === "allow_once" ? "allowed" : "denied" };
      },
      pending: async () => [card],
    } as unknown as TuiDeps["api"],
    snapshot: async () => snap,
    connect: (handlers) => {
      push = handlers.onFrame;
      handlers.onConnection?.(true);
      return { subscribe() {}, unsubscribe() {}, close() {} };
    },
    control: {
      available: true,
      up: async () => true,
      down: async () => {},
      restart: async () => {
        calls.restarts += 1;
        return true;
      },
    },
    config: {
      read: () => readConfig(envFile),
      set: (field, raw) => setConfig(envFile, field, raw),
      rotateToken: () => void rotateToken(envFile),
    },
    relay: async () => 0,
    pair: async () => ({ qr: "[QR]", bases: ["http://100.64.0.10:8787"] }),
    readLogTail: () => ["line 1", "error: boom"],
    ...overrides,
  };
  return { deps, calls, envFile, push: (f: ServerFrame) => push?.(f) };
}

async function settle(ms = 80): Promise<void> {
  await delay(ms);
}

async function slashCommand(ui: ReturnType<typeof render>, name: string): Promise<void> {
  ui.stdin.write("/");
  await settle();
  ui.stdin.write(name);
  await settle();
  ui.stdin.write("\r");
  await settle();
}

test("主界面：会话列表、运行状态、待审批横幅、预览", async () => {
  const { deps } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(300);
  const frame = ui.lastFrame() ?? "";
  assert.match(frame, /Claude Remote/);
  assert.match(frame, /运行中\s+3d 0h/);
  assert.match(frame, /claude-remote\s+修复 WS 半开连接检测/);
  assert.match(frame, /pi-remote\s+Relay 重连丢消息/);
  assert.match(frame, /1 个待审批：Bash rm -rf build/);
  assert.match(frame, /你\s+你好/);
  ui.unmount();
});

test("审批：a 进入、y 允许一次；WS resolved 后横幅消失", async () => {
  const { deps, calls, push } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  ui.stdin.write("a");
  await settle();
  assert.match(ui.lastFrame() ?? "", /Run Bash\?/);
  ui.stdin.write("y");
  await settle();
  assert.deepEqual(calls.decide, [["int-1", { type: "allow_once" }]]);
  assert.match(ui.lastFrame() ?? "", /已允许 Bash/);
  assert.match(ui.lastFrame() ?? "", /没有待审批的操作/);

  // 新审批经 WS 推来 → 回主界面能看到横幅；resolved 帧后消失
  ui.stdin.write("\u001b");
  await settle();
  push({ type: "approval", interaction: { ...card, interactionId: "int-2", toolName: "Edit", input: { file_path: "/a.ts" } } });
  await settle();
  assert.match(ui.lastFrame() ?? "", /1 个待审批：Edit \/a\.ts/);
  push({ type: "approval.resolved", interactionId: "int-2", status: "allowed" });
  await settle();
  assert.doesNotMatch(ui.lastFrame() ?? "", /待审批/);
  ui.unmount();
});

test("搜索：/search 输入关键词，Tab 切全文，结果带片段", async () => {
  const { deps, calls } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  await slashCommand(ui, "search");
  ui.stdin.write("filter");
  await settle(30);
  ui.stdin.write("\t");
  await settle(600);
  assert.deepEqual(calls.search.at(-1), ["filter", true]);
  const frame = ui.lastFrame() ?? "";
  assert.match(frame, /Relay 重连丢消息 ↳ …git filter-repo…/);
  assert.doesNotMatch(frame, /修复 WS 半开连接检测/);
  ui.unmount();
});

test("o：空闲会话退出 TUI 去 resume；运行中的会话拒绝接管", async () => {
  const exits: TuiExit[] = [];
  const { deps } = fakeDeps();
  const ui = render(<App deps={deps} onExit={(e) => exits.push(e)} />);
  await settle(200);
  ui.stdin.write("j"); // 选中运行中的 pi-remote
  await settle();
  ui.stdin.write("o");
  await settle();
  assert.equal(exits.length, 0);
  assert.match(ui.lastFrame() ?? "", /会话正运行中，现在接管会和另一端抢/);
  ui.stdin.write("k");
  await settle();
  ui.stdin.write("o");
  await settle();
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.kind, "resume");
  ui.unmount();
});

test("会话视图：Enter 进入，输入回复经 daemon 发送", async () => {
  const { deps, calls } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /经 daemon 发送/);
  ui.stdin.write("继续");
  await settle(30);
  ui.stdin.write("\r");
  await settle();
  assert.deepEqual(calls.sent, ["继续"]);
  ui.unmount();
});

test("daemon 未运行：提示按 s 启动，s 调用 up", async () => {
  let upCalled = false;
  const { deps } = fakeDeps({
    snapshot: async () => ({ launchd: { loaded: false, installed: true }, reachable: false, unauthorized: false, sessions: [], pending: [], error: "fetch failed" }),
    control: { available: true, up: async () => { upCalled = true; return true; }, down: async () => {}, restart: async () => true },
  });
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  assert.match(ui.lastFrame() ?? "", /未运行 · 按 s 启动/);
  ui.stdin.write("s");
  await settle();
  assert.equal(upCalled, true);
  ui.unmount();
});

test("设置：c 进入，改审批超时（秒→毫秒写 .env）并重启 daemon，不重载", async () => {
  const { deps, calls, envFile } = fakeDeps();
  let exited: TuiExit | undefined;
  const ui = render(<App deps={deps} onExit={(r) => (exited = r)} />);
  await settle(300);
  ui.stdin.write("c");
  await settle();
  let frame = ui.lastFrame() ?? "";
  assert.match(frame, /监听地址\s+127\.0\.0\.1\s+默认/);
  assert.match(frame, /重置 token/);
  for (let i = 0; i < 4; i += 1) {
    ui.stdin.write("j");
    await settle(30);
  }
  assert.match(ui.lastFrame() ?? "", /超时自动拒绝/); // 选中项的说明
  ui.stdin.write("\r");
  await settle();
  ui.stdin.write("600");
  await settle();
  ui.stdin.write("\r");
  await settle(200);
  assert.match(readFileSync(envFile, "utf8"), /^PERMISSION_TIMEOUT_MS=600000$/m);
  assert.equal(calls.restarts, 1);
  assert.equal(exited, undefined);
  frame = ui.lastFrame() ?? "";
  assert.match(frame, /审批超时（秒）\s+600/);
  assert.match(frame, /已保存，daemon 已重启/);
  // d 恢复默认
  ui.stdin.write("d");
  await settle(200);
  assert.doesNotMatch(readFileSync(envFile, "utf8"), /PERMISSION_TIMEOUT_MS/);
  ui.unmount();
});

test("设置：非法端口提示错误不写入；合法端口重启后重载 TUI", async () => {
  const { deps, calls, envFile } = fakeDeps();
  let exited: TuiExit | undefined;
  const ui = render(<App deps={deps} onExit={(r) => (exited = r)} initialView="settings" />);
  await settle(300);
  ui.stdin.write("j");
  await settle(30);
  ui.stdin.write("\r");
  await settle();
  ui.stdin.write("99999");
  await settle();
  ui.stdin.write("\r");
  await settle(150);
  assert.match(ui.lastFrame() ?? "", /端口：需要 1–65535 的整数/);
  assert.doesNotMatch(readFileSync(envFile, "utf8"), /BRIDGE_PORT/);
  assert.equal(calls.restarts, 0);
  // 还在编辑：清空重输
  for (let i = 0; i < 5; i += 1) {
    ui.stdin.write("\x7f");
    await settle(20);
  }
  ui.stdin.write("8790");
  await settle();
  ui.stdin.write("\r");
  await settle(200);
  assert.match(readFileSync(envFile, "utf8"), /^BRIDGE_PORT=8790$/m);
  assert.equal(calls.restarts, 1);
  assert.deepEqual(exited, { kind: "reload", then: "settings" });
  ui.unmount();
});

test("设置：开机自启 Enter 直接切换，退出 TUI 让 main 切换托管方式（不重启 daemon）", async () => {
  const { deps, envFile, calls } = fakeDeps();
  let exited: TuiExit | undefined;
  const ui = render(<App deps={deps} onExit={(r) => (exited = r)} initialView="settings" />);
  await settle(300);
  for (let i = 0; i < CONFIG_FIELDS.findIndex((f) => f.key === "AUTOSTART"); i += 1) {
    ui.stdin.write("j");
    await settle(20);
  }
  ui.stdin.write("\r");
  await settle(200);
  assert.match(readFileSync(envFile, "utf8"), /AUTOSTART=on/);
  assert.deepEqual(exited, { kind: "reload", then: "settings" });
  assert.equal(calls.restarts, 0);
  ui.unmount();
});

test("设置：重置 token 需 y 确认，之后重载并打开配对", async () => {
  const { deps, envFile } = fakeDeps();
  let exited: TuiExit | undefined;
  const ui = render(<App deps={deps} onExit={(r) => (exited = r)} initialView="settings" />);
  await settle(300);
  for (let i = 0; i < CONFIG_FIELDS.length; i += 1) {
    ui.stdin.write("j");
    await settle(20);
  }
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /按 y 确认/);
  ui.stdin.write("x"); // 取消
  await settle();
  assert.match(readFileSync(envFile, "utf8"), /BRIDGE_TOKEN=old-token/);
  ui.stdin.write("\r");
  await settle();
  ui.stdin.write("y");
  await settle(200);
  assert.doesNotMatch(readFileSync(envFile, "utf8"), /old-token/);
  assert.deepEqual(exited, { kind: "reload", then: "pair" });
  ui.unmount();
});

test("设置：只读显示 relay 状态（取自 daemon 快照，光标不会停在这一行）", async () => {
  const base = { launchd: { loaded: true, installed: true }, reachable: true, unauthorized: false, sessions: [], pending: [] };
  const file = { configured: true, enabled: true, relays: [{ url: "https://r.example.com", base: "https://r.example.com/d/abc" }] };
  const cases: Array<[DaemonSnapshot, RegExp]> = [
    [{ ...base, relayFile: file, connect: { bases: [], relays: [{ state: "connected", base: file.relays[0]!.base, since: now }] } }, /relay\s+1\/1 已连接/],
    [{ ...base, relayFile: file, connect: { bases: [], relays: [{ state: "error", error: "auth", base: file.relays[0]!.base, since: now }] } }, /relay 密钥错误/],
    [{ ...base, relayFile: { configured: false, enabled: false, relays: [] } }, /relay\s+未配置/],
  ];
  for (const [snap, expected] of cases) {
    const { deps } = fakeDeps({ snapshot: async () => snap });
    const ui = render(<App deps={deps} onExit={() => {}} initialView="settings" />);
    await settle(300);
    for (let i = 0; i < CONFIG_FIELDS.length + 3; i += 1) {
      ui.stdin.write("j");
      await settle(20);
    }
    const frame = ui.lastFrame() ?? "";
    assert.match(frame, expected);
    assert.match(frame, /❯ 重置 token/);
    ui.unmount();
  }
});

test("会话详情：PgUp 翻历史停在原地，PgDn 回到底部跟随新消息", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, blockIndex: 0, uuid: `u${i}`, role: "user" as const, kind: "text" as const, text: `第${i}行` }));
  const { deps, push } = fakeDeps();
  deps.api = { ...deps.api!, messages: async () => ({ messages: many, hasMore: false }) } as NonNullable<TuiDeps["api"]>;
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /第39行/);
  assert.doesNotMatch(ui.lastFrame() ?? "", /已上翻/);

  ui.stdin.write("\u001b[5~"); // PgUp
  await settle();
  const scrolled = ui.lastFrame() ?? "";
  assert.match(scrolled, /已上翻 \d+ 行/);
  assert.doesNotMatch(scrolled, /第39行/);

  // 翻上去时来了新消息，视口不跟着跳
  push({ type: "message", sessionId: sessions[0]!.sessionId, message: { seq: 41, blockIndex: 0, uuid: "u41", role: "user", kind: "text", text: "第40行" } });
  await settle();
  assert.doesNotMatch(ui.lastFrame() ?? "", /第40行/);

  for (let i = 0; i < 5; i += 1) {
    ui.stdin.write("\u001b[6~"); // PgDn
    await settle(30);
  }
  assert.doesNotMatch(ui.lastFrame() ?? "", /已上翻/);
  assert.match(ui.lastFrame() ?? "", /第40行/);
  ui.unmount();
});

test("命令面板：筛选、方向键执行与 Esc 恢复搜索", async (t) => {
  const { deps, calls } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  t.after(ui.unmount);
  await settle(200);
  await slashCommand(ui, "search");
  ui.stdin.write("filter");
  await settle(300);
  ui.stdin.write("\x1b[Z");
  await settle();
  assert.match(ui.lastFrame() ?? "", /命令面板/);
  ui.stdin.write("not-a-command");
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /没有匹配的命令/);
  ui.stdin.write("\x1b");
  await settle();
  assert.match(ui.lastFrame() ?? "", /filter/);
  assert.deepEqual(calls.search, [["filter", false]]);

  ui.stdin.write("\x1b[Z");
  await settle();
  ui.stdin.write("\x1b[B");
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /Run Bash\?/);
  assert.deepEqual(calls.decide, []);
  ui.stdin.write("\x1b");
  await settle();
  ui.stdin.write(":");
  await settle();
  ui.stdin.write("配对");
  await settle();
  assert.match(ui.lastFrame() ?? "", /\/pair/);
  assert.doesNotMatch(ui.lastFrame() ?? "", /\/logs/);
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /\[QR\]/);
});

test("斜杠命令：添加 Relay、用新地址扫码、在控制台查看日志和设置", async (t) => {
  const { deps, envFile } = fakeDeps();
  const url = "https://relay.example.com";
  const secret = "x".repeat(40);
  let reloads = 0;
  deps.relay = (args, out, signal) => runRelay(args, {
    envFile, out, signal,
    fetch: async (input) => {
      assert.equal(String(input), `${url}/healthz`);
      return Response.json({ ok: true });
    },
    reload: async () => { reloads += 1; return { kind: "reloaded" }; },
    restart: async () => assert.fail("应使用热加载"),
    connectInfo: async () => ({ bases: [], relays: readRelayFile(envFile).relays.map((entry) => ({
      state: "connected", base: entry.base!, since: now,
    })) }),
  });
  deps.pair = async () => ({ qr: "[QR]", bases: configuredRelayBases(envFile) });
  const ui = render(<App deps={deps} onExit={() => {}} />);
  t.after(ui.unmount);
  await settle();
  await slashCommand(ui, "relay add");
  assert.match(ui.lastFrame() ?? "", /地址 ❯/);
  ui.stdin.write("invalid");
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /请输入有效的 Relay 地址/);
  ui.stdin.write("\x1b");
  await settle();
  assert.equal(readRelayFile(envFile).configured, false);

  await slashCommand(ui, "relay add");
  ui.stdin.write(`${url}/`);
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /密钥 ❯/);
  ui.stdin.write("bad");
  await settle();
  ui.stdin.write("\r");
  await settle();
  assert.match(ui.lastFrame() ?? "", /relay 密钥至少/);
  assert.equal(readRelayFile(envFile).configured, false);
  ui.stdin.write("\x7f");
  await settle(30);
  ui.stdin.write("\x7f");
  await settle(30);
  ui.stdin.write("\x7f");
  await settle(30);
  ui.stdin.write(secret);
  await settle();
  assert.match(ui.lastFrame() ?? "", /\*{20}/);
  assert.ok(ui.frames.every((frame) => !frame.includes(secret)));
  ui.stdin.write("\r");
  await settle(150);
  assert.match(ui.lastFrame() ?? "", /已连接 relay/);
  assert.equal(readRelayFile(envFile).relays[0]?.url, url);
  assert.equal(reloads, 1);

  await slashCommand(ui, "pair");
  assert.match(ui.lastFrame() ?? "", /\[QR\]/);
  assert.match(ui.lastFrame() ?? "", /https:\/\/relay\.example\.com\/d\//);
  await slashCommand(ui, "pair");
  assert.match(ui.lastFrame() ?? "", /\[QR\]/);
  await slashCommand(ui, "logs");
  assert.match(ui.lastFrame() ?? "", /\/logs · daemon 日志/);
  assert.match(ui.lastFrame() ?? "", /error: boom/);
  await slashCommand(ui, "config");
  assert.match(ui.lastFrame() ?? "", /重置 token/);
  assert.ok(ui.frames.every((frame) => !frame.includes(secret)));
});

test("Relay 检查失败时显示错误，可在控制台重试，离开后中止检查", async (t) => {
  const { deps, envFile } = fakeDeps();
  let activeSignal: AbortSignal | undefined;
  let waitForAbort = false;
  deps.relay = (args, out, signal) => runRelay(args, {
    envFile, out, signal,
    fetch: async () => {
      activeSignal = signal;
      if (!waitForAbort) return Response.json({ ok: false }, { status: 503 });
      await delay(10_000, undefined, { signal });
      return Response.json({ ok: true });
    },
    restart: async () => assert.fail("未写入配置时不能重启"),
    connectInfo: async () => ({ bases: [], relays: [] }),
  });
  const ui = render(<App deps={deps} onExit={() => {}} />);
  t.after(ui.unmount);
  await settle();
  await slashCommand(ui, "relay add");
  const fill = async (): Promise<void> => {
    ui.stdin.write("https://relay.example.com");
    await settle();
    ui.stdin.write("\r");
    await settle();
    ui.stdin.write("x".repeat(40));
    await settle();
    ui.stdin.write("\r");
    await settle();
  };
  await fill();
  assert.match(ui.lastFrame() ?? "", /503/);
  assert.match(ui.lastFrame() ?? "", /a 添加/);
  assert.equal(readRelayFile(envFile).configured, false);
  ui.stdin.write("a");
  await settle();
  waitForAbort = true;
  await fill();
  assert.match(ui.lastFrame() ?? "", /处理中/);
  ui.unmount();
  await settle();
  assert.equal(activeSignal?.aborted, true);
  assert.equal(readRelayFile(envFile).configured, false);
});

test("会话详情：长回复完整换行，保留代码缩进和空行", async (t) => {
  const longLine = `${"中".repeat(45)}回答末尾`;
  const { deps } = fakeDeps();
  deps.api = { ...deps.api!, messages: async () => ({
    messages: [{ seq: 1, blockIndex: 0, uuid: "u", role: "assistant", kind: "text", text: `回复开头\n${longLine}\n\n代码：\n    const value = 1;` }],
    hasMore: false,
  }) };
  const ui = render(<App deps={deps} onExit={() => {}} />);
  t.after(ui.unmount);
  await settle(200);
  ui.stdin.write("\r");
  await settle();
  const frame = ui.lastFrame() ?? "";
  assert.match(frame, /回复开头/);
  assert.match(frame, /回答末尾\n *\n *代码：\n {12}const value = 1;/);
  assert.doesNotMatch(frame, /中…/);
});

test("底部提示只留常用键，其余收进帮助页", async () => {
  const { deps } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  const main = ui.lastFrame() ?? "";
  assert.match(main, /\/ 命令 · a 审批/);
  assert.doesNotMatch(main, /p 配对/);
  ui.stdin.write("?");
  await settle();
  const help = ui.lastFrame() ?? "";
  assert.match(help, /命令行等价/);
  assert.match(help, /cr pair \/ logs \/ status \/ relay/);
  assert.match(help, /PgUp\/PgDn/);
  ui.unmount();
});
