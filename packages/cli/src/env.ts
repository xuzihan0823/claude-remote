// CLI 运行环境：定位仓库、读 .env、解析 token / 端口 / 日志路径。
//
// token 来源优先级与 scripts/launchd/run-daemon.sh 保持一致：
//   进程环境 BRIDGE_TOKEN > 仓库 .env > Keychain（旧菜单栏 App 写入的 service=claude-remote / account=bridge-token）
// 这样 launchd 起的 daemon 和 CLI 永远拿到同一个 token，已配对的手机不受迁移影响。

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TokenSource = "env" | "dotenv" | "keychain" | "none";

/**
 * 运行形态：
 *   repo     从 git 仓库源码运行（开发者 / 老用户）：配置在仓库 .env，launchd 走 scripts/launchd/run-daemon.sh + tsx
 *   package  npm 全局安装的编译产物：配置与数据在 ~/.claude-remote（CLAUDE_REMOTE_HOME 可改），launchd 直接 node dist/daemon.js
 */
export type InstallMode = "repo" | "package";

export interface CliEnv {
  mode: InstallMode;
  /** repo 模式：仓库根目录；package 模式：npm 包根目录（含 dist/）。 */
  repoDir: string;
  /** 配置与数据目录（package 模式 ~/.claude-remote；repo 模式即仓库根目录）。 */
  dataDir: string;
  envFile: string;
  /** package 模式下 launchd 直接运行的 daemon 入口。 */
  daemonEntry: string;
  /** daemon 监听端口（BRIDGE_PORT，默认 8787）。 */
  port: number;
  /** CLI 访问 daemon 的地址（总是走本机）。 */
  baseUrl: string;
  token: string | undefined;
  tokenSource: TokenSource;
  logDir: string;
  logFile: string;
}

export const KEYCHAIN_SERVICE = "claude-remote";
export const KEYCHAIN_ACCOUNT = "bridge-token";

/**
 * 定位运行形态与根目录：
 *   CLAUDE_REMOTE_REPO 显式指定 → repo；
 *   源码运行（packages/cli/src，上三级有 pnpm-workspace.yaml）→ repo；
 *   否则是 npm 包里的 dist/cli.js → package，包根目录是上一级。
 */
export function findInstall(env: NodeJS.ProcessEnv = process.env, here = dirname(fileURLToPath(import.meta.url))): { mode: InstallMode; root: string } {
  const fromEnv = env.CLAUDE_REMOTE_REPO?.trim();
  if (fromEnv) return { mode: "repo", root: resolve(fromEnv) };
  const repo = resolve(here, "../../..");
  if (existsSync(join(repo, "pnpm-workspace.yaml"))) return { mode: "repo", root: repo };
  return { mode: "package", root: resolve(here, "..") };
}

/** @deprecated 兼容旧调用：返回 findInstall().root。 */
export function findRepoDir(env: NodeJS.ProcessEnv = process.env): string {
  return findInstall(env).root;
}

/** 极简 dotenv 解析：KEY=VALUE、可选 export 前缀、单/双引号、# 注释。 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

export function readDotenv(envFile: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(envFile, "utf8"));
  } catch {
    return {};
  }
}

export function readKeychainToken(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const value = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

export interface LoadEnvDeps {
  env?: NodeJS.ProcessEnv;
  keychain?: () => string | undefined;
  home?: string;
  /** 测试用：覆盖 findInstall 的结果。 */
  install?: { mode: InstallMode; root: string };
}

export function loadCliEnv(deps: LoadEnvDeps = {}): CliEnv {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const { mode, root: repoDir } = deps.install ?? findInstall(env);
  const dataDir = mode === "repo" ? repoDir : resolve(env.CLAUDE_REMOTE_HOME?.trim() || join(home, ".claude-remote"));
  const envFile = mode === "repo" ? join(repoDir, ".env") : join(dataDir, "config.env");
  const dotenv = readDotenv(envFile);

  let token: string | undefined;
  let tokenSource: TokenSource = "none";
  if (env.BRIDGE_TOKEN?.trim()) {
    token = env.BRIDGE_TOKEN.trim();
    tokenSource = "env";
  } else if (dotenv.BRIDGE_TOKEN) {
    token = dotenv.BRIDGE_TOKEN;
    tokenSource = "dotenv";
  } else {
    const fromKeychain = (deps.keychain ?? readKeychainToken)();
    if (fromKeychain !== undefined) {
      token = fromKeychain;
      tokenSource = "keychain";
    }
  }

  const portRaw = env.BRIDGE_PORT?.trim() || dotenv.BRIDGE_PORT || "8787";
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`BRIDGE_PORT 非法：${portRaw}`);
  }

  // daemon 绑定具体 IP（如 Tailscale IP）时 127.0.0.1 连不上，只能直连该 IP；
  // 绑定 0.0.0.0 / :: / 缺省时走 loopback（配对端点仅允许 loopback）。
  const host = env.BRIDGE_HOST?.trim() || dotenv.BRIDGE_HOST || "127.0.0.1";
  const reachable = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const hostPart = reachable.includes(":") ? `[${reachable}]` : reachable;

  const logDir = join(home, "Library", "Logs", "claude-remote");
  return {
    mode,
    repoDir,
    dataDir,
    envFile,
    daemonEntry: join(repoDir, "dist", "daemon.js"),
    port,
    baseUrl: `http://${hostPart}:${port}`,
    token,
    tokenSource,
    logDir,
    logFile: join(logDir, "daemon.log"),
  };
}

/** 把 KEY=VALUE 写进 .env：已有该键（含空值）则替换，否则追加。返回新文本。 */
export function upsertDotenv(text: string, key: string, value: string): string {
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    next.push(`${key}=${value}`);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 保证 .env 里有 BRIDGE_TOKEN（setup 用）。
 * 已有 → 不动；Keychain 里有旧 token → 迁移进 .env（手机不用重新配对）；都没有 → 生成新的。
 */
export function ensureToken(cliEnv: CliEnv): { token: string; action: "kept" | "migrated" | "generated" } {
  const dotenv = readDotenv(cliEnv.envFile);
  if (dotenv.BRIDGE_TOKEN) return { token: dotenv.BRIDGE_TOKEN, action: "kept" };
  const migrated = cliEnv.tokenSource === "keychain" ? cliEnv.token : undefined;
  const token = migrated ?? generateToken();
  const current = existsSync(cliEnv.envFile) ? readFileSync(cliEnv.envFile, "utf8") : "";
  mkdirSync(dirname(cliEnv.envFile), { recursive: true, mode: 0o700 });
  writeFileSync(cliEnv.envFile, upsertDotenv(current, "BRIDGE_TOKEN", token), { mode: 0o600 });
  return { token, action: migrated === undefined ? "generated" : "migrated" };
}
