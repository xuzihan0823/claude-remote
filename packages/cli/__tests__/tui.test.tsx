import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { render } from "ink-testing-library";

import type { ApprovalCard, Decision, ServerFrame, SessionSummary } from "../src/api.js";
import type { DaemonSnapshot } from "../src/daemon-control.js";
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
  const calls = { decide: [] as Array<[string, Decision]>, search: [] as Array<[string, boolean]>, sent: [] as string[] };
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
    control: { available: true, up: async () => true, down: async () => {}, restart: async () => true },
    pair: async () => ({ qr: "[QR]", bases: ["http://100.64.0.10:8787"] }),
    openWeb: () => "已打开浏览器",
    readLogTail: () => ["line 1", "error: boom"],
    ...overrides,
  };
  return { deps, calls, push: (f: ServerFrame) => push?.(f) };
}

async function settle(ms = 80): Promise<void> {
  await delay(ms);
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

test("搜索：/ 输入关键词，Tab 切全文，结果带片段", async () => {
  const { deps, calls } = fakeDeps();
  const ui = render(<App deps={deps} onExit={() => {}} />);
  await settle(200);
  ui.stdin.write("/");
  await settle(30);
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
