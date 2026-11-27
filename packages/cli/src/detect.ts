// 首次安装时探测 claude 可执行文件和会话目录。
//
// launchd 起的 daemon 没有交互 shell 的 PATH，必须把 claude 的绝对路径记进配置（CLAUDE_BIN）：
// daemon 驱动会话时交给 Agent SDK（pathToClaudeCodeExecutable），cr open 接管时也用它。
//
// 查找顺序：
//   1. 当前进程 PATH（在终端里运行 cr setup 时通常就能找到）
//   2. 登录 + 交互 shell 的 PATH（加载 .zprofile / .zshrc，nvm / fnm / volta 都在这里配置）
//   3. 常见安装位置：官方安装器 ~/.claude/local、~/.local/bin、Homebrew、npm 全局、bun、volta、nvm、fnm
//
// Windows：没有登录 shell，PATH 里找 claude.exe；常见位置是 ~/.local/bin（官方安装器）与 npm 全局目录。
// 只收 .exe：npm 的 claude.cmd 只是个垫片，Agent SDK 与 Node 的 spawn 都不能直接执行它，
// 这种情况改取垫片旁 node_modules/@anthropic-ai/claude-code/bin/claude.exe。

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";

export interface ClaudeCandidate {
  path: string;
  source: string;
}

export interface DetectedClaude extends ClaudeCandidate {
  version: string | undefined;
}

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 运行 `<shell> -ilc 'command -v claude'`，返回 stdout；失败返回 undefined。 */
  loginShellWhich?: () => string | undefined;
  /** `npm prefix -g` */
  npmPrefix?: () => string | undefined;
  isExecutable?: (path: string) => boolean;
  listDir?: (dir: string) => string[];
  version?: (path: string) => string | undefined;
  /** 测试用：覆盖 process.platform。 */
  platform?: NodeJS.Platform;
  /** Windows：`where claude` 的 stdout。 */
  whereClaude?: () => string | undefined;
  /** 测试用：覆盖 existsSync（判断 npm 垫片是否存在）。 */
  fileExists?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows 没有 X 位，accessSync(X_OK) 等同于存在性检查
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      ...(env === undefined ? {} : { env }),
    });
  } catch {
    return undefined;
  }
}

function defaultLoginShellWhich(env: NodeJS.ProcessEnv): string | undefined {
  const shell = env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // -i 才会读 .zshrc（nvm 通常配在这里）；stdin 关掉，避免交互 shell 等输入
  return run(shell, ["-ilc", "command -v claude"], env);
}

/** 版本号排序：v22.12.0 > v22.9.1 > v20.0.0 */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0 && Number.isFinite(d)) return d;
  }
  return 0;
}

function windowsClaudeCandidates(deps: DetectDeps, env: NodeJS.ProcessEnv, home: string): ClaudeCandidate[] {
  const out: ClaudeCandidate[] = [];
  const add = (path: string | undefined, source: string): void => {
    if (path === undefined || path === "" || !win32.isAbsolute(path)) return;
    if (!out.some((c) => c.path.toLowerCase() === path.toLowerCase())) out.push({ path, source });
  };
  // npm 垫片 → 包内的原生 claude.exe
  const addShim = (shim: string, source: string): void => {
    const lower = shim.toLowerCase();
    if (lower.endsWith(".exe")) return add(shim, source);
    if (!/\.(cmd|bat|ps1)$/.test(lower) && !lower.endsWith("claude")) return;
    if (!(deps.fileExists ?? existsSync)(shim)) return; // 垫片真的存在才展开，避免给每个 PATH 目录都猜一个
    add(win32.join(win32.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), `${source}（npm 全局）`);
  };

  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (dir === "") continue;
    add(win32.join(dir, "claude.exe"), "当前 PATH");
    addShim(win32.join(dir, "claude.cmd"), "当前 PATH");
  }
  const where = (deps.whereClaude ?? (() => run("where", ["claude"], env)))();
  for (const line of where?.split(/\r?\n/) ?? []) {
    const path = line.trim();
    if (path !== "") addShim(path, "where claude");
  }

  add(win32.join(home, ".local", "bin", "claude.exe"), "官方安装器（~/.local/bin）");
  add(win32.join(home, ".claude", "local", "claude.exe"), "~/.claude/local");
  const appData = env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming");
  addShim(win32.join(appData, "npm", "claude.cmd"), "%APPDATA%/npm");
  const prefix = (deps.npmPrefix ?? (() => run("npm", ["prefix", "-g"], env)?.trim()))();
  if (prefix) addShim(win32.join(prefix, "claude.cmd"), "npm 全局");
  add(win32.join(home, ".bun", "bin", "claude.exe"), "bun");
  return out;
}

/** 按优先级列出所有候选（去重，未验证可执行）。 */
export function claudeCandidates(deps: DetectDeps = {}): ClaudeCandidate[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  if ((deps.platform ?? process.platform) === "win32") return windowsClaudeCandidates(deps, env, home);
  const listDir = deps.listDir ?? defaultListDir;
  const out: ClaudeCandidate[] = [];
  const add = (path: string | undefined, source: string): void => {
    if (path === undefined || path === "" || !path.startsWith("/")) return;
    if (!out.some((c) => c.path === path)) out.push({ path, source });
  };

  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir !== "") add(join(dir, "claude"), "当前 PATH");

  const shellOut = (deps.loginShellWhich ?? (() => defaultLoginShellWhich(env)))();
  // 交互 shell 可能先打印欢迎语等，取最后一个绝对路径行
  const shellPath = shellOut
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"))
    .pop();
  add(shellPath, "登录 shell 的 PATH");

  add(join(home, ".claude", "local", "claude"), "官方安装器（~/.claude/local）");
  add(join(home, ".local", "bin", "claude"), "~/.local/bin");
  add("/opt/homebrew/bin/claude", "Homebrew");
  add("/usr/local/bin/claude", "/usr/local/bin");
  const prefix = (deps.npmPrefix ?? (() => run("npm", ["prefix", "-g"], env)?.trim()))();
  if (prefix) add(join(prefix, "bin", "claude"), "npm 全局");
  add(join(home, ".npm-global", "bin", "claude"), "npm 全局（~/.npm-global）");
  add(join(home, ".bun", "bin", "claude"), "bun");
  add(join(home, ".volta", "bin", "claude"), "volta");

  const nvmDir = join(env.NVM_DIR?.trim() || join(home, ".nvm"), "versions", "node");
  for (const v of listDir(nvmDir).sort(compareVersionsDesc)) add(join(nvmDir, v, "bin", "claude"), `nvm（${v}）`);
  const fnmDir = join(home, "Library", "Application Support", "fnm", "node-versions");
  for (const v of listDir(fnmDir).sort(compareVersionsDesc)) add(join(fnmDir, v, "installation", "bin", "claude"), `fnm（${v}）`);
  return out;
}

/** 检查一个已知路径：可执行则返回带版本的结果。 */
export function inspectClaude(path: string, source: string, deps: DetectDeps = {}): DetectedClaude | undefined {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  if (!isExecutable(path)) return undefined;
  const version = deps.version ?? ((p: string) => run(p, ["--version"])?.trim() || undefined);
  return { path, source, version: version(path) };
}

/** 找到第一个可执行的 claude 并读取版本；找不到返回 undefined。 */
export function detectClaude(deps: DetectDeps = {}): DetectedClaude | undefined {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const version = deps.version ?? ((path: string) => run(path, ["--version"])?.trim() || undefined);
  for (const candidate of claudeCandidates(deps)) {
    if (!isExecutable(candidate.path)) continue;
    return { ...candidate, version: version(candidate.path) };
  }
  return undefined;
}

/** ~/.claude/projects 下有会话记录的项目数（目录不存在返回 undefined）。 */
export function countProjects(projectsDir = join(homedir(), ".claude", "projects")): number | undefined {
  if (!existsSync(projectsDir)) return undefined;
  return defaultListDir(projectsDir).filter((name) => {
    try {
      return statSync(join(projectsDir, name)).isDirectory();
    } catch {
      return false;
    }
  }).length;
}
