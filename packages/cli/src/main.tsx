// cr 入口：无参数且在 TTY 中 → 全屏 TUI；否则执行子命令。

import { render } from "ink";

import {
  cmdConfig,
  cmdDown,
  cmdLogs,
  cmdLs,
  cmdOpen,
  cmdPair,
  cmdRestart,
  cmdSearch,
  cmdSetup,
  cmdShow,
  cmdStatus,
  cmdUninstall,
  cmdUp,
  cmdWeb,
  describeError,
  HELP,
} from "./commands.js";
import { ensureDaemon, makeContext, resumeInTerminal, type Context } from "./daemon-control.js";
import { loadCliEnv } from "./env.js";
import { App, type TuiExit, type View } from "./tui/App.js";
import { realDeps } from "./tui/deps.js";

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

/** 全屏 TUI 循环：o 接管会话时退出 TUI 跑 claude，claude 结束后回到 TUI。 */
async function runTui(initial: Context): Promise<void> {
  let ctx = initial;
  let view: View = "main";
  let prepare = true;
  for (;;) {
    if (prepare) {
      prepare = false;
      try {
        const note = await ensureDaemon(ctx);
        if (note !== undefined) console.log(`✓ ${note}`);
      } catch (error) {
        console.error(`✗ 启动 daemon 失败：${describeError(error)}`);
      }
    }
    let result = { kind: "quit" } as TuiExit;
    process.stdout.write(ENTER_ALT);
    const instance = render(<App deps={realDeps(ctx)} initialView={view} onExit={(r) => (result = r)} />, { exitOnCtrlC: false });
    try {
      await instance.waitUntilExit();
    } finally {
      instance.cleanup();
      process.stdout.write(LEAVE_ALT);
    }
    if (result.kind === "quit") return;
    if (result.kind === "reload") {
      // 设置页改了地址/端口/token：daemon 已重启，换用新的连接参数再进 TUI
      ctx = makeContext(loadCliEnv());
      view = result.then;
      prepare = true;
      continue;
    }
    view = "main";
    const { session } = result;
    console.log(`接管会话 ${session.sessionId}（${session.cwd || "未知目录"}），退出 claude 后回到 cr\n`);
    await resumeInTerminal(session, ctx.env.envFile);
  }
}

export async function main(argv: string[], binPath: string): Promise<void> {
  const [cmd, ...args] = argv;
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log("cr 0.1.0");
    return;
  }

  const ctx = makeContext(loadCliEnv());
  try {
    switch (cmd) {
      case undefined:
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stdout.write(HELP);
          return;
        }
        if (ctx.env.token === undefined) {
          // 首次运行：还没有 token，先走一遍 setup（生成 token、找 claude、注册 launchd）
          console.log("首次运行，先完成初始化（之后可随时 cr setup 重新执行）\n");
          await cmdSetup(ctx, binPath);
          console.log("");
          await runTui(makeContext(loadCliEnv()));
          return;
        }
        await runTui(ctx);
        return;
      case "setup":
        return await cmdSetup(ctx, binPath);
      case "up":
      case "start":
        return await cmdUp(ctx);
      case "down":
      case "stop":
        return await cmdDown(ctx);
      case "restart":
        return await cmdRestart(ctx);
      case "uninstall":
        return await cmdUninstall(ctx);
      case "status":
        return await cmdStatus(ctx);
      case "logs":
        return await cmdLogs(ctx);
      case "pair":
        return await cmdPair(ctx);
      case "config":
        return await cmdConfig(ctx, args);
      case "web":
        return await cmdWeb(ctx);
      case "ls":
        return await cmdLs(ctx, args);
      case "search":
        return await cmdSearch(ctx, args);
      case "show":
        return await cmdShow(ctx, args);
      case "open":
      case "resume":
        return await cmdOpen(ctx, args);
      default:
        console.error(`未知命令：${cmd}\n`);
        process.stdout.write(HELP);
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(`✗ ${describeError(error)}`);
    process.exitCode = 1;
  }
}
