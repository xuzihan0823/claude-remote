// daemon 配置：环境变量 → 结构化配置（变量表见 docs/api-contract.md）。
//
// 缺 BRIDGE_TOKEN 抛 ConfigError 由入口拒绝启动；数值变量非法同样拒启
// （静默回退默认值会掩盖配置错误，宁可启动失败）。

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import { deriveDeviceId, isDeviceId, isDeviceKey } from "@claude-remote/relay/protocol";

export class ConfigError extends Error {}

/** relay 接入参数（RELAY_*，由 `cr relay` 管理）。 */
export interface RelaySettings {
  /** 规范化后的 relay 地址：无末尾斜杠、无 query/fragment。 */
  url: string;
  secret: string;
  deviceId: string;
  deviceKey: string;
}

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
  /** relay 已配置且启用时存在。 */
  relay?: RelaySettings;
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

/** 与 relay 服务端 RELAY_SECRET 的最短长度一致（packages/relay/src/config.ts）。 */
export const MIN_RELAY_SECRET_LENGTH = 32;

/**
 * relay 地址规范化：必须 https；http 只允许 localhost / 127.0.0.1（本地测试）。
 * 不允许账号密码、query、fragment。非法返回 undefined。
 */
export function normalizeRelayUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * relay 密钥会进 Authorization 头：只接受可见 ASCII。
 * 它以不加引号的形式写进 .env，process.loadEnvFile 会把 # 之后当注释、并处理引号与反斜杠，故一并排除。
 */
export function isRelaySecret(value: string): boolean {
  return value.length >= MIN_RELAY_SECRET_LENGTH && /^[\x21-\x7e]+$/.test(value) && !/["'`#\\]/.test(value);
}

/** 手机经 relay 访问这台 Mac 的 base；配对二维码、connect-info、connector 状态共用。 */
export function relayBase(settings: Pick<RelaySettings, "url" | "deviceId">): string {
  return `${settings.url}/d/${settings.deviceId}`;
}

/**
 * 读 RELAY_*：RELAY_ENABLED=off 或四个必需值缺任一 → undefined（relay 未启用）；
 * 值非法抛 ConfigError。
 */
export function loadRelaySettings(env: NodeJS.ProcessEnv = process.env): RelaySettings | undefined {
  const enabled = readString(env, "RELAY_ENABLED") ?? "on";
  if (enabled !== "on" && enabled !== "off") throw new ConfigError(`RELAY_ENABLED must be on or off, got: ${enabled}`);
  if (enabled === "off") return undefined;
  const rawUrl = readString(env, "RELAY_URL");
  const secret = readString(env, "RELAY_SECRET");
  const deviceId = readString(env, "RELAY_DEVICE_ID");
  const deviceKey = readString(env, "RELAY_DEVICE_KEY");
  if (rawUrl === undefined || secret === undefined || deviceId === undefined || deviceKey === undefined) return undefined;
  const url = normalizeRelayUrl(rawUrl);
  if (url === undefined) {
    throw new ConfigError("RELAY_URL must be an https:// URL (http:// only for localhost / 127.0.0.1), without query or credentials");
  }
  if (!isRelaySecret(secret)) {
    throw new ConfigError(`RELAY_SECRET must be at least ${MIN_RELAY_SECRET_LENGTH} printable ASCII characters`);
  }
  if (!isDeviceId(deviceId)) throw new ConfigError("RELAY_DEVICE_ID is malformed (managed by cr relay)");
  if (!isDeviceKey(deviceKey)) throw new ConfigError("RELAY_DEVICE_KEY is malformed (managed by cr relay)");
  if (deriveDeviceId(deviceKey) !== deviceId) {
    throw new ConfigError("RELAY_DEVICE_ID does not match RELAY_DEVICE_KEY (run cr relay add again)");
  }
  return { url, secret, deviceId, deviceKey };
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
  const relay = loadRelaySettings(env);
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
    ...(relay === undefined ? {} : { relay }),
  };
}
