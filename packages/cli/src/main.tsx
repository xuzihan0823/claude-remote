// cr 入口：无参数且在 TTY 中 → 全屏 TUI；否则执行子命令。

import { render } from "ink";

import {
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
import { makeContext, resumeInTerminal, type Context } from "./daemon-control.js";
import { loadCliEnv } from "./env.js";
import { App, type TuiExit } from "./tui/App.js";
import { realDeps } from "./tui/deps.js";

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

/** 全屏 TUI 循环：o 接管会话时退出 TUI 跑 claude，claude 结束后回到 TUI。 */
async function runTui(ctx: Context): Promise<void> {
  for (;;) {
    let result = { kind: "quit" } as TuiExit;
    process.stdout.write(ENTER_ALT);
    const instance = render(<App deps={realDeps(ctx)} onExit={(r) => (result = r)} />, { exitOnCtrlC: false });
    try {
      await instance.waitUntilExit();
    } finally {
      instance.cleanup();
      process.stdout.write(LEAVE_ALT);
    }
    if (result.kind === "quit") return;
    const { session } = result;
    console.log(`接管会话 ${session.sessionId}（${session.cwd || "未知目录"}），退出 claude 后回到 cr\n`);
    await resumeInTerminal(session);
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
