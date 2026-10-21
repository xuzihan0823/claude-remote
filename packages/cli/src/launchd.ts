// launchd 控制：原 scripts/launchd/install.sh 的 TypeScript 版，供 cr up/down/restart/status 复用。
//
// LaunchAgent 由 launchd 托管：登录即起、崩溃自动拉起、与任何终端会话无关。
// Label 与旧脚本相同（com.claude-remote.daemon），旧安装可直接被接管。
//
// 启停语义：
//   up      写 plist（内容变化才重写）→ enable → bootstrap，等 /api/health 响应
//   down    bootout + disable：立即停止，且下次登录也不自动起（disable 状态跨登录持久）
//   restart kickstart -k（未加载时等同 up）
//   uninstall bootout + 删除 plist

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAEMON_LABEL = "com.claude-remote.daemon";

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** launchd 要运行的程序。repo 模式走 run-daemon.sh（login shell + tsx），package 模式直接 node dist/daemon.js。 */
export interface LaunchProgram {
  args: string[];
  workingDir: string;
  env: Record<string, string>;
}

export interface PlistInput {
  program: LaunchProgram;
  logFile: string;
}

export function renderPlist({ program, logFile }: PlistInput): string {
  const log = xmlEscape(logFile);
  const args = program.args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const env = Object.entries(program.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(program.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- 任何原因退出都重启；主动停止请用 cr down -->
  <key>KeepAlive</key>
  <true/>
  <!-- 崩溃循环时最少间隔 10 秒再拉起 -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- daemon 收到 SIGTERM 后会关 WS、等活跃 run settle；给足时间再 SIGKILL -->
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

/** repo 模式：以 login shell 运行 run-daemon.sh（加载 ~/.zprofile 里的 Homebrew 等 PATH，再 exec tsx）。 */
export function repoProgram(repoDir: string): LaunchProgram {
  return {
    args: ["/bin/zsh", "-l", join(repoDir, "scripts", "launchd", "run-daemon.sh")],
    workingDir: repoDir,
    env: { CLAUDE_REMOTE_REPO: repoDir },
  };
}

/**
 * package 模式：node 直接跑编译好的 daemon。launchd 没有 shell PATH，
 * 显式给出 node 和 claude 所在目录（npm 装的 claude 是 #!/usr/bin/env node 脚本，也需要 node 在 PATH 里）。
 */
export function packageProgram(opts: {
  nodePath: string;
  daemonEntry: string;
  dataDir: string;
  envFile: string;
  claudeBin?: string | undefined;
  home: string;
}): LaunchProgram {
  const dirs = [
    ...(opts.claudeBin !== undefined && opts.claudeBin.includes("/") ? [dirname(opts.claudeBin)] : []),
    dirname(opts.nodePath),
    join(opts.home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    args: [opts.nodePath, opts.daemonEntry],
    workingDir: opts.dataDir,
    env: { CLAUDE_REMOTE_ENV_FILE: opts.envFile, PATH: [...new Set(dirs)].join(":") },
  };
}

export interface LaunchdState {
  loaded: boolean;
  installed: boolean;
  state?: string;
  pid?: number;
  lastExitCode?: string;
  runs?: number;
}

/** 从 `launchctl print gui/<uid>/<label>` 输出里取顶层字段。 */
export function parseLaunchctlPrint(text: string): Omit<LaunchdState, "loaded" | "installed"> {
  const pick = (key: string): string | undefined => {
    const match = new RegExp(`^\\s*${key} = (.+)$`, "m").exec(text);
    return match?.[1]?.trim();
  };
  const out: Omit<LaunchdState, "loaded" | "installed"> = {};
  const state = pick("state");
  if (state !== undefined) out.state = state;
  const pid = Number(pick("pid"));
  if (Number.isSafeInteger(pid) && pid > 0) out.pid = pid;
  const lastExit = pick("last exit code");
  if (lastExit !== undefined) out.lastExitCode = lastExit;
  const runs = Number(pick("runs"));
  if (Number.isSafeInteger(runs)) out.runs = runs;
  return out;
}

export type Exec = (cmd: string, args: string[]) => string;

const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface LaunchdOptions {
  /** 每次 up 时重新计算（claude 路径等配置可能变了）。 */
  program: () => LaunchProgram;
  logFile: string;
  exec?: Exec;
  home?: string;
  uid?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class Launchd {
  readonly plistPath: string;
  readonly #opts: LaunchdOptions;
  readonly #exec: Exec;
  readonly #domain: string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: LaunchdOptions) {
    this.#opts = opts;
    this.#exec = opts.exec ?? defaultExec;
    const home = opts.home ?? homedir();
    this.plistPath = join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
    this.#domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get target(): string {
    return `${this.#domain}/${DAEMON_LABEL}`;
  }

  #try(cmd: string, args: string[]): string | undefined {
    try {
      return this.#exec(cmd, args);
    } catch {
      return undefined;
    }
  }

  isLoaded(): boolean {
    return this.#try("launchctl", ["print", this.target]) !== undefined;
  }

  status(): LaunchdState {
    const printed = this.#try("launchctl", ["print", this.target]);
    const installed = existsSync(this.plistPath);
    if (printed === undefined) return { loaded: false, installed };
    return { loaded: true, installed, ...parseLaunchctlPrint(printed) };
  }

  /** 写 plist；内容未变返回 false。 */
  writePlist(): boolean {
    const content = renderPlist({ program: this.#opts.program(), logFile: this.#opts.logFile });
    const current = existsSync(this.plistPath) ? readFileSync(this.plistPath, "utf8") : undefined;
    if (current === content) return false;
    mkdirSync(join(this.plistPath, ".."), { recursive: true });
    mkdirSync(join(this.#opts.logFile, ".."), { recursive: true });
    writeFileSync(this.plistPath, content);
    return true;
  }

  async #bootout(): Promise<void> {
    if (!this.isLoaded()) return;
    this.#try("launchctl", ["bootout", this.target]);
    // bootout 是异步的，等它真正卸载，避免紧接着 bootstrap 报 "service already loaded"
    for (let i = 0; i < 50 && this.isLoaded(); i += 1) await this.#sleep(200);
  }

  /** 安装/启动。plist 有变化时先卸载再加载，让新配置生效。 */
  async up(): Promise<{ changed: boolean; alreadyRunning: boolean }> {
    const changed = this.writePlist();
    this.#try("launchctl", ["enable", this.target]);
    if (this.isLoaded() && !changed) return { changed, alreadyRunning: true };
    await this.#bootout();
    this.#exec("launchctl", ["bootstrap", this.#domain, this.plistPath]);
    return { changed, alreadyRunning: false };
  }

  async down(): Promise<void> {
    await this.#bootout();
    this.#try("launchctl", ["disable", this.target]);
  }

  async restart(): Promise<void> {
    if (!this.isLoaded()) {
      await this.up();
      return;
    }
    this.#exec("launchctl", ["kickstart", "-k", this.target]);
  }

  async uninstall(): Promise<void> {
    await this.#bootout();
    rmSync(this.plistPath, { force: true });
  }

  /** 端口被非 launchd 实例（nohup / 终端 pnpm dev）占用时的 pid 列表。 */
  strayListeners(port: number): number[] {
    const out = this.#try("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]) ?? "";
    const own = this.status().pid;
    return out
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== own);
  }
}
