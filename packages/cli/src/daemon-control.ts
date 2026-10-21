// daemon 控制与状态探测：子命令和 TUI 共用。

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { enumeratePairBases, pairPayload, type PairInfo } from "@claude-remote/daemon/pair";

import { Api, ApiError, type ApprovalCard, type SessionSummary } from "./api.js";
import { findRepoDir, readDotenv, type CliEnv } from "./env.js";
import { Launchd, type LaunchdState } from "./launchd.js";

export interface Context {
  env: CliEnv;
  launchd: Launchd;
  api: Api | undefined;
}

export function makeContext(env: CliEnv): Context {
  return {
    env,
    launchd: new Launchd({ repoDir: env.repoDir, logFile: env.logFile }),
    api: env.token === undefined ? undefined : new Api(env.baseUrl, env.token),
  };
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
  error?: string;
}

export async function snapshot(ctx: Context, opts: { withSessions?: boolean } = {}): Promise<DaemonSnapshot> {
  const launchd = process.platform === "darwin" ? ctx.launchd.status() : { loaded: false, installed: false };
  const snap: DaemonSnapshot = { launchd, reachable: false, unauthorized: false, sessions: [], pending: [] };
  if (launchd.pid !== undefined) {
    const up = processUptime(launchd.pid);
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
    const [sessions, pending] = await Promise.all([
      opts.withSessions === false ? Promise.resolve({ sessions: [] as SessionSummary[] }) : ctx.api.sessions(200),
      ctx.api.pending().catch(() => [] as ApprovalCard[]),
    ]);
    snap.sessions = sessions.sessions;
    snap.pending = pending;
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

export function pairInfo(ctx: Context): PairInfo | undefined {
  if (ctx.env.token === undefined) return undefined;
  return { bases: enumeratePairBases(ctx.env.port), token: ctx.env.token };
}

export { pairPayload };

export async function terminalQr(info: PairInfo): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toString(pairPayload(info), { type: "terminal", small: true });
}

export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

/** 复制到剪贴板（仅 macOS pbcopy），失败静默。 */
export function copyToClipboard(text: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("pbcopy", [], { input: text });
    return true;
  } catch {
    return false;
  }
}

/** claude 可执行文件：环境变量 CLAUDE_BIN > .env 里的 CLAUDE_BIN（cr config set claude）> PATH。 */
export function claudeBin(envFile = join(findRepoDir(), ".env")): string {
  return process.env.CLAUDE_BIN?.trim() || readDotenv(envFile).CLAUDE_BIN || "claude";
}

/**
 * 在当前终端接管会话（claude --resume），返回子进程退出码。
 * cwd 必须是会话原始目录：claude 按 cwd 编码目录查找会话文件。
 */
export function resumeInTerminal(session: Pick<SessionSummary, "sessionId" | "cwd">): Promise<number> {
  const cwd = session.cwd !== "" && existsSync(session.cwd) ? session.cwd : process.cwd();
  return new Promise((resolvePromise) => {
    const child = spawn(claudeBin(), ["--resume", session.sessionId], { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`无法启动 claude：${error.message}（可用 CLAUDE_BIN 指定路径）`);
      resolvePromise(127);
    });
    child.on("exit", (code) => resolvePromise(code ?? 0));
  });
}
