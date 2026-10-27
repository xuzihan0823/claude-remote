// relay 配置：环境变量 → 结构化配置。缺密钥或数值非法时抛 ConfigError 拒绝启动（与 daemon 约定一致）。

import process from "node:process";

export class ConfigError extends Error {}

export interface RelayConfig {
  secret: string;
  host: string;
  port: number;
  /** 每台设备的并发流上限。 */
  maxStreams: number;
  /** 单个 HTTP 请求体上限（字节）；同时用作手机 WS 单条消息上限。 */
  maxBodyBytes: number;
}

export const MIN_SECRET_LENGTH = 32;
/** 与 daemon 的上传上限 UPLOAD_LIMIT_BYTES（packages/daemon/src/server.ts，25 MiB）对齐。 */
export const DEFAULT_MAX_BODY_MB = 25;

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ConfigError(`${key} must be an integer between 1 and ${max}, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const secret = readString(env, "RELAY_SECRET");
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`RELAY_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters; refusing to start`);
  }
  return {
    secret,
    host: readString(env, "RELAY_HOST") ?? "127.0.0.1",
    port: readInt(env, "RELAY_PORT", 8790, 65535),
    maxStreams: readInt(env, "RELAY_MAX_STREAMS", 64),
    maxBodyBytes: readInt(env, "RELAY_MAX_BODY_MB", DEFAULT_MAX_BODY_MB, 4096) * 1024 * 1024,
  };
}
