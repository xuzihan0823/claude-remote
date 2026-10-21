// 子命令实现。不带参数运行 cr 进入全屏 TUI（tui/），这里的子命令供脚本与快速操作使用。

import { spawn } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ApiError, type SessionSummary } from "./api.js";
import {
  copyToClipboard,
  openUrl,
  pairInfo,
  resumeInTerminal,
  makeContext,
  snapshot,
  terminalQr,
  waitHealthy,
  type Context,
} from "./daemon-control.js";
import { CONFIG_FIELDS, findField, readConfig, rotateToken, setConfig } from "./config.js";
import { ensureToken, loadCliEnv } from "./env.js";
import {
  describeMessage,
  fit,
  formatUptime,
  projectName,
  relativeTime,
  shortId,
  STATUS_ICON,
  STATUS_LABEL,
} from "./format.js";

export const HELP = `cr — Claude Remote 控制台

用法：
  cr                    打开全屏控制台（会话 / 搜索 / 审批 / 配对 / 日志）
  cr setup              首次安装：生成 token、把 cr 链接到 ~/.local/bin、注册 launchd 并启动
  cr up | down | restart  启动（并开机自启）/ 停止（并取消自启）/ 重启 daemon
  cr status             daemon 状态、配对地址、会话与待审批数量
  cr logs               跟随 daemon 日志
  cr pair               终端打印配对二维码
  cr config             查看配置；cr config set <项> <值> / unset <项> / reset-token
                        项：host port bark ntfy timeout cooldown claude uploads（改完自动重启 daemon）
  cr web                浏览器打开 Web 界面（token 复制到剪贴板）
  cr ls [-n 20]         最近会话
  cr search <词> [--full]  搜标题/项目路径；--full 连对话全文一起搜
  cr show <id>          最近消息（id 可写前缀）
  cr open <id>          在当前终端 claude --resume 接着聊
  cr uninstall          移除 launchd 服务（不删数据）
`;

function touch(file: string): void {
  closeSync(openSync(file, "a"));
}

function requireDarwin(): void {
  if (process.platform !== "darwin") throw new Error("launchd 相关命令只支持 macOS");
}

function requireApi(ctx: Context): NonNullable<Context["api"]> {
  if (ctx.api === undefined) throw new Error("没有找到 BRIDGE_TOKEN，先运行 cr setup");
  return ctx.api;
}

async function resolveSession(ctx: Context, prefix: string): Promise<SessionSummary> {
  const { sessions } = await requireApi(ctx).sessions(500);
  const hits = sessions.filter((s) => s.sessionId.startsWith(prefix));
  if (hits.length === 0) throw new Error(`没有以 ${prefix} 开头的会话`);
  if (hits.length > 1) throw new Error(`前缀 ${prefix} 匹配到 ${hits.length} 个会话，请多写几位`);
  return hits[0] as SessionSummary;
}

function sessionRow(s: SessionSummary, columns = process.stdout.columns ?? 100): string {
  const titleWidth = Math.max(16, columns - 8 - 18 - 12 - 12);
  return [
    `${STATUS_ICON[s.status]} ${shortId(s.sessionId)}`,
    fit(projectName(s.cwd), 16),
    fit(s.title, titleWidth),
    fit(relativeTime(s.lastActiveAt), 10),
  ].join("  ");
}

export async function cmdUp(ctx: Context): Promise<void> {
  requireDarwin();
  if (!ctx.launchd.isLoaded()) {
    const strays = ctx.launchd.strayListeners(ctx.env.port);
    if (strays.length > 0) {
      console.log(`端口 ${ctx.env.port} 被进程 ${strays.join(" ")} 占用（多半是手工起的旧 daemon），发送 SIGTERM`);
      for (const pid of strays) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // 已退出
        }
      }
      for (let i = 0; i < 50 && ctx.launchd.strayListeners(ctx.env.port).length > 0; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  const { changed, alreadyRunning } = await ctx.launchd.up();
  if (alreadyRunning) console.log("✓ daemon 已在 launchd 下运行");
  else console.log(`✓ 已${changed ? "安装并" : ""}启动 launchd 服务（开机自启、崩溃自动拉起）`);
  if (await waitHealthy(ctx)) console.log(`✓ ${ctx.env.baseUrl} 已响应`);
  else console.log(`✗ 20 秒内没有响应，看看日志：cr logs（${ctx.env.logFile}）`);
}

export async function cmdDown(ctx: Context): Promise<void> {
  requireDarwin();
  await ctx.launchd.down();
  console.log("✓ daemon 已停止，并取消开机自启（cr up 恢复）");
}

export async function cmdRestart(ctx: Context): Promise<void> {
  requireDarwin();
  await ctx.launchd.restart();
  console.log("✓ 已重启");
  if (!(await waitHealthy(ctx))) console.log(`✗ 20 秒内没有响应，看看日志：cr logs`);
}

export async function cmdUninstall(ctx: Context): Promise<void> {
  requireDarwin();
  await ctx.launchd.uninstall();
  console.log(`✓ 已移除 ${ctx.launchd.plistPath}`);
}

export async function cmdStatus(ctx: Context): Promise<void> {
  const snap = await snapshot(ctx);
  const l = snap.launchd;
  const daemonLine = snap.reachable && !snap.unauthorized
    ? `运行中${l.pid === undefined ? "" : `  pid ${l.pid}`}${snap.uptimeMs === undefined ? "" : `  已运行 ${formatUptime(snap.uptimeMs)}`}  v${snap.version}`
    : snap.unauthorized
      ? "运行中，但 token 不匹配"
      : "未响应";
  console.log(`daemon   ${daemonLine}`);
  const launchdLine = l.loaded
    ? `已加载（${l.state ?? "?"}${l.runs === undefined ? "" : `，启动过 ${l.runs} 次`}${l.lastExitCode === undefined ? "" : `，上次退出 ${l.lastExitCode}`}）`
    : l.installed
      ? "已安装但未加载（cr up）"
      : "未安装（cr setup）";
  console.log(`launchd  ${launchdLine}`);
  if (snap.claudeCliVersion !== undefined) console.log(`claude   ${snap.claudeCliVersion}`);
  const info = pairInfo(ctx);
  if (info !== undefined) console.log(`地址     ${info.bases.join(" · ")}`);
  if (snap.reachable && !snap.unauthorized) {
    const running = snap.sessions.filter((s) => s.status !== "idle").length;
    console.log(`会话     共 ${snap.sessions.length} 个 · ${running} 个运行中 · ${snap.pending.length} 个待审批`);
  }
  if (snap.error !== undefined && !snap.reachable) console.log(`提示     ${snap.error}`);
  if (!snap.reachable || snap.unauthorized) process.exitCode = 1;
}

export async function cmdLogs(ctx: Context): Promise<void> {
  mkdirSync(ctx.env.logDir, { recursive: true });
  touch(ctx.env.logFile);
  await new Promise<void>((resolvePromise) => {
    const child = spawn("tail", ["-n", "80", "-F", ctx.env.logFile], { stdio: "inherit" });
    child.on("exit", () => resolvePromise());
    process.once("SIGINT", () => child.kill("SIGINT"));
  });
}

export async function cmdPair(ctx: Context): Promise<void> {
  const info = pairInfo(ctx);
  if (info === undefined) throw new Error("没有找到 BRIDGE_TOKEN，先运行 cr setup");
  console.log(await terminalQr(info));
  console.log("iPhone 相机扫码，点「在 Claude Remote 中打开」即可配对。候选地址：");
  for (const base of info.bases) console.log(`  ${base}`);
  console.log("\n二维码就是凭据，别截图外传。");
}

export async function cmdWeb(ctx: Context): Promise<void> {
  const url = `${ctx.env.baseUrl}/`;
  openUrl(url);
  const copied = ctx.env.token !== undefined && copyToClipboard(ctx.env.token);
  console.log(`已打开 ${url}${copied ? "，token 已复制到剪贴板（首次登录粘贴即可）" : ""}`);
}

export async function cmdLs(ctx: Context, args: string[]): Promise<void> {
  const nIdx = args.indexOf("-n");
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) || 20 : 20;
  const { sessions, total } = await requireApi(ctx).sessions(n);
  for (const s of sessions) console.log(sessionRow(s));
  if (total > sessions.length) console.log(`… 共 ${total} 个，cr ls -n ${Math.min(total, 500)} 看更多`);
}

export async function cmdSearch(ctx: Context, args: string[]): Promise<void> {
  const full = args.includes("--full") || args.includes("-f");
  const q = args.filter((a) => a !== "--full" && a !== "-f").join(" ").trim();
  if (q === "") throw new Error("用法：cr search <关键词> [--full]");
  const { results, truncated } = await requireApi(ctx).search(q, full, 30);
  if (results.length === 0) {
    console.log(full ? "没有匹配的会话" : "标题和路径里没找到，试试 cr search <词> --full 搜全文");
    return;
  }
  for (const r of results) {
    console.log(sessionRow(r));
    if (r.match.field === "content" || r.match.field === "preview") console.log(`             ↳ ${r.match.snippet}`);
  }
  if (truncated) console.log("（历史太大，全文检索提前停止，结果可能不完整）");
}

export async function cmdShow(ctx: Context, args: string[]): Promise<void> {
  const prefix = args[0];
  if (prefix === undefined) throw new Error("用法：cr show <会话 id 前缀>");
  const session = await resolveSession(ctx, prefix);
  const { messages } = await requireApi(ctx).messages(session.sessionId, 20);
  console.log(`${STATUS_ICON[session.status]} ${projectName(session.cwd)} · ${session.title} · ${STATUS_LABEL[session.status]}\n`);
  for (const m of messages) {
    if (m.kind === "thinking") continue;
    const { who, text } = describeMessage(m);
    const body = m.kind === "tool_result" ? fit(text, 100, false) : text.trim();
    console.log(`${who}: ${body}\n`);
  }
}

export async function cmdOpen(ctx: Context, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const prefix = args.find((a) => !a.startsWith("--"));
  if (prefix === undefined) throw new Error("用法：cr open <会话 id 前缀> [--force]");
  const session = await resolveSession(ctx, prefix);
  if (session.status !== "idle" && !force) {
    throw new Error(`这个会话正${STATUS_LABEL[session.status]}，此时接管会和手机端抢同一个会话。等它空闲，或加 --force`);
  }
  process.exitCode = await resumeInTerminal(session);
}

/** cr setup：token、PATH 链接、launchd。幂等，可重复运行。 */
export async function cmdSetup(ctx: Context, binPath: string): Promise<void> {
  const { action } = ensureToken(ctx.env);
  const tokenMsg = {
    kept: "沿用 .env 里的 BRIDGE_TOKEN",
    migrated: "已把菜单栏 App 存在 Keychain 的 token 迁移到 .env（已配对的手机不用重配）",
    generated: "已生成新的 BRIDGE_TOKEN 写入 .env",
  }[action];
  console.log(`✓ ${tokenMsg}`);

  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, "cr");
  mkdirSync(binDir, { recursive: true });
  const target = resolve(binPath);
  let linkOk = false;
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink() && resolve(binDir, readlinkSync(link)) === target) linkOk = true;
    else rmSync(link);
  } catch {
    // 不存在
  }
  if (!linkOk) symlinkSync(target, link);
  console.log(`✓ ${link} → ${target}`);
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    console.log(`  ~/.local/bin 不在 PATH 里，在 ~/.zshrc 加一行：export PATH="$HOME/.local/bin:$PATH"`);
  }

  if (process.platform === "darwin") {
    // token 可能刚写入，重新加载环境再起 daemon
    const fresh = { ...ctx, env: loadCliEnv() };
    await cmdUp(fresh);
  } else {
    console.log("非 macOS：跳过 launchd，用 pnpm dev 前台运行 daemon");
  }
  if (action === "migrated") {
    console.log("提示：菜单栏 App 已不再需要，可从「登录项」里移除并删掉 ClaudeRemote.app");
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "token 与 daemon 不一致（检查 .env 的 BRIDGE_TOKEN，改完 cr restart）";
    if (error.status === 409) return "会话正忙，稍后再试";
    return `daemon 返回 ${error.status} ${error.code}`;
  }
  if (error instanceof Error) {
    if (/fetch failed|ECONNREFUSED/.test(error.message) || error.name === "TimeoutError") {
      return "连不上 daemon（cr status 看看，或 cr up 启动）";
    }
    return error.message;
  }
  return String(error);
}

// -- cr config ---------------------------------------------------------------

function printConfig(ctx: Context): void {
  const values = readConfig(ctx.env.envFile);
  const aliasWidth = Math.max(...values.map((v) => v.field.alias.length));
  for (const { field, value } of values) {
    const shown = value ?? `${field.fallback} [默认]`;
    console.log(`${field.alias.padEnd(aliasWidth)}  ${fit(field.label, 18)}  ${shown}`);
  }
  console.log(`\ntoken    ${ctx.env.token === undefined ? "未设置（cr setup）" : `已设置（来源：${ctx.env.tokenSource}）`}`);
  console.log(`文件     ${ctx.env.envFile}`);
}

/** 配置写入后：launchd 在跑就重启让它生效，否则提示。返回重启后（可能已换端口/token）的新上下文。 */
async function applyConfig(ctx: Context, opts: { restart: boolean }): Promise<Context> {
  const next = makeContext(loadCliEnv());
  if (!opts.restart) {
    console.log("已保存，重启 daemon 后生效（cr restart）");
    return next;
  }
  if (process.platform !== "darwin" || !ctx.launchd.isLoaded()) {
    console.log("已保存。daemon 不在 launchd 下运行，下次启动时生效");
    return next;
  }
  await ctx.launchd.restart();
  console.log((await waitHealthy(next)) ? `✓ 已重启 daemon，${next.env.baseUrl} 已响应` : "✗ 重启后 20 秒内没有响应，看看日志：cr logs");
  return next;
}

export async function cmdConfig(ctx: Context, args: string[]): Promise<void> {
  const restart = !args.includes("--no-restart");
  const [sub, name, ...rest] = args.filter((a) => a !== "--no-restart");
  if (sub === undefined || sub === "list" || sub === "ls") {
    printConfig(ctx);
    return;
  }
  if (sub === "reset-token") {
    rotateToken(ctx.env.envFile);
    console.log("✓ 已生成新 token，旧 token 立即失效：已配对的手机和浏览器需要重新扫码（cr pair）");
    await applyConfig(ctx, { restart });
    return;
  }
  const field = name === undefined ? undefined : findField(name);
  if (field === undefined) {
    throw new Error(`未知配置项：${name ?? "（缺少）"}。可用：${CONFIG_FIELDS.map((f) => f.alias).join(" ")}`);
  }
  if (sub === "get") {
    const value = readConfig(ctx.env.envFile).find((v) => v.field.key === field.key)?.value;
    console.log(value ?? field.fallback);
    return;
  }
  if (sub === "set" || sub === "unset") {
    const raw = sub === "unset" ? "" : rest.join(" ");
    if (sub === "set" && raw.trim() === "") throw new Error(`用法：cr config set ${field.alias} <值>（恢复默认用 unset）`);
    setConfig(ctx.env.envFile, field, raw);
    console.log(sub === "unset" ? `✓ ${field.label} 已恢复默认（${field.fallback}）` : `✓ ${field.label} = ${raw.trim()}`);
    if (field.key === "BRIDGE_PORT" || field.key === "BRIDGE_HOST") console.log("  已配对的手机需要重新扫码（cr pair）");
    // claude 路径只影响 cr 自己，不必重启 daemon
    await applyConfig(ctx, { restart: restart && field.key !== "CLAUDE_BIN" });
    return;
  }
  throw new Error(`未知子命令：config ${sub}。用法见 cr --help`);
}
