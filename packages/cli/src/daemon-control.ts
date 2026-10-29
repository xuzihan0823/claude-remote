// daemon 控制与状态探测：子命令和 TUI 共用。

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadRelaySettings, relayBase } from "@claude-remote/daemon/config";
import { pairBases, pairPayload, type PairInfo } from "@claude-remote/daemon/pair";

import { Api, ApiError, type ApprovalCard, type ConnectInfo, type SessionSummary } from "./api.js";
import { AttachedDaemon } from "./attached.js";
import { readDotenv, type CliEnv } from "./env.js";
import { Launchd, packageProgram, repoProgram, type LaunchdState, type LaunchProgram } from "./launchd.js";
import { readRelayFile, type RelayFileState, type RestartResult } from "./relay.js";

export interface Context {
  env: CliEnv;
  launchd: Launchd;
  /** 开机自启关闭时：daemon 随 cr 运行。 */
  attached: AttachedDaemon;
  api: Api | undefined;
}

/** 开机自启（launchd 托管）是否打开：.env 的 AUTOSTART=on；默认关，daemon 随 cr 启停。非 macOS 永远随 cr。 */
export function autostartEnabled(env: CliEnv): boolean {
  return process.platform === "darwin" && readDotenv(env.envFile).AUTOSTART === "on";
}

// 同一个 cr 进程里 ctx 会因 reload 重建，但子进程归属必须延续：按 pidFile 复用实例
const attachedByPidFile = new Map<string, AttachedDaemon>();

export function makeContext(env: CliEnv): Context {
  const program = (): LaunchProgram =>
    env.mode === "repo"
      ? repoProgram(env.repoDir)
      : packageProgram({
          nodePath: process.execPath,
          daemonEntry: env.daemonEntry,
          dataDir: env.dataDir,
          envFile: env.envFile,
          claudeBin: readDotenv(env.envFile).CLAUDE_BIN,
          home: homedir(),
        });
  const pidFile = join(env.logDir, "daemon.pid");
  let attached = attachedByPidFile.get(pidFile);
  if (attached === undefined) {
    attached = new AttachedDaemon({
      program,
      logFile: env.logFile,
      pidFile,
      healthy: () => probeHealth(env.baseUrl),
      waitHealthy: () => waitHealthyUrl(env.baseUrl),
    });
    attachedByPidFile.set(pidFile, attached);
  }
  return {
    env,
    launchd: new Launchd({ logFile: env.logFile, program }),
    attached,
    api: env.token === undefined ? undefined : new Api(env.baseUrl, env.token),
  };
}

/**
 * 进 TUI 前按开机自启开关把 daemon 摆到对的状态：
 *  - 开：交给 launchd（先停掉本进程拉起的子进程，避免抢端口）；
 *  - 关：launchd 若还装着就卸掉（不再开机自启），再由 cr 拉起子进程，cr 退出时一起停。
 * 返回一句给用户看的说明（无事发生时为 undefined）。
 */
export async function ensureDaemon(ctx: Context): Promise<string | undefined> {
  if (autostartEnabled(ctx.env)) {
    if (ctx.attached.ownedPid !== undefined) await ctx.attached.stop();
    const { alreadyRunning } = await ctx.launchd.up();
    if (!alreadyRunning) await waitHealthy(ctx);
    return alreadyRunning ? undefined : "daemon 已交给 launchd（开机自启）";
  }
  let note: string | undefined;
  if (process.platform === "darwin" && (ctx.launchd.isLoaded() || existsSync(ctx.launchd.plistPath))) {
    await ctx.launchd.uninstall();
    note = "已取消开机自启，daemon 改为随 cr 运行";
  }
  const how = await ctx.attached.ensure();
  if (how === "started") return note ?? "daemon 已随 cr 启动，退出 cr 时一起停止";
  return note;
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

async function waitHealthyUrl(baseUrl: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** ps etime（[[dd-]hh:]mm:ss）→ 毫秒。 */
export function parseEtime(text: string): number | undefined {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (match === null) return undefined;
  const [, d = "0", h = "0", m = "0", s = "0"] = match;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

function processUptime(pid: number): number | undefined {
  try {
    return parseEtime(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return undefined;
  }
}

export interface DaemonSnapshot {
  launchd: LaunchdState;
  /** daemon HTTP 可达。 */
  reachable: boolean;
  /** 可达但 token 不对。 */
  unauthorized: boolean;
  version?: string;
  claudeCliVersion?: string;
  uptimeMs?: number;
  sessions: SessionSummary[];
  pending: ApprovalCard[];
  /** daemon 报告的候选地址与 relay 状态（旧 daemon 没有该接口时缺省）。 */
  connect?: ConnectInfo;
  /** 配置文件里的 relay 设置（daemon 没在跑时也能展示）。 */
  relayFile?: RelayFileState;
  error?: string;
}

export async function snapshot(ctx: Context, opts: { withSessions?: boolean } = {}): Promise<DaemonSnapshot> {
  const launchd = process.platform === "darwin" ? ctx.launchd.status() : { loaded: false, installed: false };
  const snap: DaemonSnapshot = {
    launchd,
    reachable: false,
    unauthorized: false,
    sessions: [],
    pending: [],
    relayFile: readRelayFile(ctx.env.envFile),
  };
  const pid = launchd.pid ?? ctx.attached.ownedPid;
  if (pid !== undefined) {
    const up = processUptime(pid);
    if (up !== undefined) snap.uptimeMs = up;
  }
  if (ctx.api === undefined) {
    snap.error = "没有找到 BRIDGE_TOKEN（先运行 cr setup）";
    return snap;
  }
  try {
    const health = await ctx.api.health();
    snap.reachable = true;
    snap.version = health.version;
    snap.claudeCliVersion = health.claudeCliVersion;
    const [sessions, pending, connect] = await Promise.all([
      opts.withSessions === false ? Promise.resolve({ sessions: [] as SessionSummary[] }) : ctx.api.sessions(200),
      ctx.api.pending().catch(() => [] as ApprovalCard[]),
      ctx.api.connectInfo().catch(() => undefined),
    ]);
    snap.sessions = sessions.sessions;
    snap.pending = pending;
    if (connect !== undefined) snap.connect = connect;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      snap.reachable = true;
      snap.unauthorized = true;
      snap.error = "token 与 daemon 不一致（检查 .env 的 BRIDGE_TOKEN）";
    } else {
      snap.error = error instanceof Error ? error.message : String(error);
    }
  }
  return snap;
}

export async function waitHealthy(ctx: Context, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ctx.env.baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200 || res.status === 401) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 配置文件里已启用的 relay 的手机地址；未启用或配置非法（daemon 会拒启并报错）时 undefined。 */
export function configuredRelayBase(envFile: string): string | undefined {
  try {
    const settings = loadRelaySettings(readDotenv(envFile));
    return settings === undefined ? undefined : relayBase(settings);
  } catch {
    return undefined;
  }
}

export function pairInfo(ctx: Context): PairInfo | undefined {
  if (ctx.env.token === undefined) return undefined;
  return { bases: pairBases(ctx.env.port, configuredRelayBase(ctx.env.envFile)), token: ctx.env.token };
}

/**
 * 改了 RELAY_* 之后让 daemon 重新读配置。launchd 托管时直接重启；
 * 随 cr 运行的 daemon 归拉起它的那个 cr 进程，这里不能代为重启（新进程会随本命令退出而停止）。
 */
export async function restartForRelay(ctx: Context): Promise<RestartResult> {
  if (process.platform === "darwin" && ctx.launchd.isLoaded()) {
    await ctx.launchd.restart();
    return (await waitHealthy(ctx)) ? { kind: "restarted" } : { kind: "unhealthy" };
  }
  if (!(await probeHealth(ctx.env.baseUrl))) return { kind: "skipped", note: "已保存。daemon 没在运行：下次启动（打开 cr）时生效" };
  return { kind: "skipped", note: "已保存。daemon 不归 launchd 托管（随 cr 运行或手动启动）：在 cr 里按 r 重启，或重启 daemon 后生效" };
}

export { pairPayload };

export async function terminalQr(info: PairInfo): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toString(pairPayload(info), { type: "terminal", small: true });
}


/** claude 可执行文件：环境变量 CLAUDE_BIN > .env 里的 CLAUDE_BIN（cr config set claude）> PATH。 */
export function claudeBin(envFile: string): string {
  return process.env.CLAUDE_BIN?.trim() || readDotenv(envFile).CLAUDE_BIN || "claude";
}

/**
 * 在当前终端接管会话（claude --resume），返回子进程退出码。
 * cwd 必须是会话原始目录：claude 按 cwd 编码目录查找会话文件。
 */
export function resumeInTerminal(session: Pick<SessionSummary, "sessionId" | "cwd">, envFile: string): Promise<number> {
  const cwd = session.cwd !== "" && existsSync(session.cwd) ? session.cwd : process.cwd();
  AttachedDaemon.foregroundChild = true;
  return new Promise<number>((resolvePromise) => {
    const child = spawn(claudeBin(envFile), ["--resume", session.sessionId], { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`无法启动 claude：${error.message}（可用 CLAUDE_BIN 指定路径）`);
      resolvePromise(127);
    });
    child.on("exit", (code) => resolvePromise(code ?? 0));
  }).finally(() => {
    AttachedDaemon.foregroundChild = false;
  });
}
