// daemon 配置：环境变量 → 结构化配置（变量表见 docs/api-contract.md）。
//
// 缺 BRIDGE_TOKEN 抛 ConfigError 由入口拒绝启动；数值变量非法同样拒启
// （静默回退默认值会掩盖配置错误，宁可启动失败）。

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

export class ConfigError extends Error {}

export interface DaemonConfig {
  token: string;
  host: string;
  port: number;
  projectsDir: string;
  /** 手机端上传文件的落盘目录（daemon 按 sessionId 分子目录）。 */
  uploadsDir: string;
  cooldownMs: number;
  interactionsDbPath: string;
  permissionTimeoutMs: number;
  barkUrl?: string;
  ntfyUrl?: string;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const token = readString(env, "BRIDGE_TOKEN");
  if (token === undefined) {
    throw new ConfigError("BRIDGE_TOKEN is required (see .env.example); refusing to start");
  }
  const port = readInt(env, "BRIDGE_PORT", 8787);
  if (port > 65535) throw new ConfigError(`BRIDGE_PORT out of range: ${port}`);

  const dbPath = readString(env, "INTERACTIONS_DB_PATH") ?? join(".data", "interactions.sqlite");
  const barkUrl = readString(env, "BARK_URL");
  const ntfyUrl = readString(env, "NTFY_URL");
  return {
    token,
    host: readString(env, "BRIDGE_HOST") ?? "127.0.0.1",
    port,
    projectsDir: readString(env, "CLAUDE_PROJECTS_DIR") ?? join(homedir(), ".claude", "projects"),
    uploadsDir: readString(env, "UPLOADS_DIR") ?? join(homedir(), ".claude-remote", "uploads"),
    cooldownMs: readInt(env, "ACTIVITY_COOLDOWN_MS", 120_000),
    interactionsDbPath: dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : join(process.cwd(), dbPath),
    permissionTimeoutMs: readInt(env, "PERMISSION_TIMEOUT_MS", 300_000),
    ...(barkUrl === undefined ? {} : { barkUrl }),
    ...(ntfyUrl === undefined ? {} : { ntfyUrl }),
  };
}
