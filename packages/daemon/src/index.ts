// daemon 入口：配置 → 装配 → 监听 → 优雅退出。
//
// 装配关系（各卡交付物的接线）：
//   SessionWatcher --write--> ActivityTracker --change--> WS status 帧
//   TurnRunner --gate--> ActivityTracker（一行适配，见 reports/04-run.md）
//   TurnRunner --permissions--> ApprovalBridge --onEvent--> WS approval 帧 + 通知
//   DaemonServer 持有全部只读/驱动入口（HTTP + WS）

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";

import { configuredClaudeExecutable } from "@claude-remote/agent-bridge";
import { InteractionManager, InteractionStore } from "@claude-remote/interactions";
import QRCode from "qrcode";

import { ConfigError, loadConfig, loadRelaySettings, relayBase, type RelaySettings } from "./config.js";
import { pairPayload } from "./pair.js";
import { RelayManager } from "./relay/manager.js";
import { ApprovalBridge, TurnRunner, createNotifier, type ActivityGate, type ApprovalEvent } from "./run/index.js";
import { DaemonServer } from "./server.js";
import { ActivityTracker } from "./watch/activity.js";
import { CliExitReleaser, readLiveCliSessions } from "./watch/cli-presence.js";
import { SessionWatcher } from "./watch/watcher.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

/** 启动时异步探测 claude CLI 版本；失败保持 "unknown"（health 端点用）。 */
function probeClaudeCliVersion(onResult: (version: string) => void): void {
  const executable = configuredClaudeExecutable();
  if (executable === undefined) return;
  execFile(executable, ["--version"], { timeout: 10_000 }, (error, stdout) => {
    if (error !== null) return;
    const version = stdout.trim();
    if (version !== "") onResult(version);
  });
}

/**
 * 热加载用：重读启动时的配置文件里的 RELAY_*。文件存在时以文件为准（cr 是唯一写入方），
 * 文件里没有 RELAY_* 就表示 relay 被删光了，不残留进程环境里的旧值。
 */
function readRelaySettings(envFile: string | undefined): RelaySettings[] {
  if (envFile === undefined) return loadRelaySettings(process.env);
  let parsed: NodeJS.ProcessEnv;
  try {
    parsed = parseEnv(readFileSync(envFile, "utf8"));
  } catch (error) {
    throw new ConfigError(`无法读取配置文件 ${envFile}：${(error as Error).message}`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("RELAY_")) delete env[key];
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("RELAY_") && value !== undefined) env[key] = value;
  }
  return loadRelaySettings(env);
}


async function main(): Promise<void> {
  // 配置文件：npm 安装形态由 launchd 传 CLAUDE_REMOTE_ENV_FILE（~/.claude-remote/config.env）；源码运行读 cwd 的 .env。
  // loadEnvFile 不覆盖已有环境变量，所以进程环境优先。
  const envFile = process.env.CLAUDE_REMOTE_ENV_FILE?.trim();
  try {
    if (envFile) process.loadEnvFile(envFile);
    else process.loadEnvFile();
  } catch (error) {
    if (envFile) console.warn(`无法读取配置文件 ${envFile}：${(error as Error).message}`);
    // 无 .env 时直接用进程环境
  }
  const config = loadConfig();

  if (config.interactionsDbPath !== ":memory:") {
    await mkdir(dirname(config.interactionsDbPath), { recursive: true });
  }
  const store = new InteractionStore(config.interactionsDbPath);
  const manager = new InteractionManager(store, { defaultTtlMs: config.permissionTimeoutMs });

  const watcher = new SessionWatcher({ projectsDir: config.projectsDir });
  const tracker: ActivityTracker = new ActivityTracker({
    cooldownMs: config.cooldownMs,
    isCliAlive: (id) => cliExitReleaser.isCliAlive(id),
  });
  const gate: ActivityGate = {
    isIdle: (id) => tracker.getStatus(id) === "idle",
    beginRun: (id) => tracker.beginRun(id),
    endRun: (id) => tracker.endRun(id),
  };
  const cliSessionsDir = join(dirname(config.projectsDir), "sessions");
  const cliExitReleaser = new CliExitReleaser({ tracker, readLive: () => readLiveCliSessions(cliSessionsDir) });
  await cliExitReleaser.tick();
  cliExitReleaser.start();

  // server 在 bridge 之后创建；审批事件只会在 HTTP/WS 流量之后产生，届时 server 已就位。
  let server: DaemonServer;
  const approvals = new ApprovalBridge({
    manager,
    onEvent: (event: ApprovalEvent) => server.handleApprovalEvent(event),
  });
  const runner = new TurnRunner({
    gate,
    permissions: approvals,
    permissionTimeoutMs: config.permissionTimeoutMs,
  });
  const notifier = createNotifier({
    ...(config.barkUrl === undefined ? {} : { barkUrl: config.barkUrl }),
    ...(config.ntfyUrl === undefined ? {} : { ntfyUrl: config.ntfyUrl }),
  });

  let claudeCliVersion = "unknown";
  probeClaudeCliVersion((version) => {
    claudeCliVersion = version;
  });

  const relays = new RelayManager();

  server = new DaemonServer({
    config,
    watcher,
    tracker,
    runner,
    approvals,
    notifier,
    version: pkg.version,
    claudeCliVersion: () => claudeCliVersion,
    isCliAlive: async (sessionId) => (await readLiveCliSessions(cliSessionsDir)).has(sessionId),
    relayStatuses: () => relays.statuses(),
    reloadRelays: () => relays.reload(readRelaySettings(envFile)),
  });

  await server.listen();
  const { host, port } = server.address();
  console.log(`${pkg.name} ${pkg.version} listening on http://${host}:${port} (projects: ${config.projectsDir})`);
  await relays.reload(config.relays);
  relays.start({ host, port });
  if (config.relays.length === 0) console.log("relay: 未启用");
  for (const settings of config.relays) console.log(`relay: 已启用，正在连接（手机地址 ${relayBase(settings)}）`);

  // 配对引导：候选地址 + 终端二维码（iPhone 相机扫码即可配对，见 docs/pairing-plan.md §3.4）
  const pairInfo = server.pairInfo;
  console.log("\n配对候选地址:");
  for (const base of pairInfo.bases) console.log(`  ${base}`);
  try {
    const qr = await QRCode.toString(pairPayload(pairInfo), { type: "terminal", small: true });
    console.log(`\n${qr}`);
  } catch (error) {
    console.warn("terminal QR render failed:", error);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.error("forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down…`);
    void (async () => {
      try {
        await relays.stop();
      } catch (error) {
        console.error("relay connector stop failed:", error);
      }
      try {
        await server.close(); // 停新连接、关 WS、abort 活跃 run 并等 settle
      } catch (error) {
        console.error("server close failed:", error);
      }
      watcher.close();
      cliExitReleaser.stop();
      tracker.dispose();
      manager.close();
      try {
        store.close();
      } catch (error) {
        console.error("store close failed:", error);
      }
      process.exit(0);
    })();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`config error: ${error.message}`);
  } else {
    console.error("daemon failed to start:", error);
  }
  process.exit(1);
});
