// daemon 配置项（读写仓库 .env）。TUI 设置页和 `cr config` 共用这一份定义。
//
// daemon 启动时用 process.loadEnvFile() 读 .env，所以改完需要重启 daemon 才生效；
// 改监听地址/端口/token 还会影响 cr 自己怎么连 daemon，调用方要重新加载 CliEnv。

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { generateToken, readDotenv, upsertDotenv } from "./env.js";

export type ConfigKey =
  | "BRIDGE_HOST"
  | "BRIDGE_PORT"
  | "BARK_URL"
  | "NTFY_URL"
  | "PERMISSION_TIMEOUT_MS"
  | "ACTIVITY_COOLDOWN_MS"
  | "CLAUDE_BIN"
  | "UPLOADS_DIR";

export interface ConfigField {
  key: ConfigKey;
  /** `cr config set <别名>` 用的短名。 */
  alias: string;
  label: string;
  hint: string;
  /** 未设置时 daemon 实际使用的值（展示用，已换算成 display 单位）。 */
  fallback: string;
  /** 存储是毫秒、展示/输入是秒。 */
  seconds?: boolean;
  /** 改了之后 cr 连接 daemon 的方式会变，需要重新加载。 */
  affectsCli?: boolean;
  validate: (value: string) => string | undefined;
}

const positiveInt = (value: string): string | undefined =>
  /^\d+$/.test(value) && Number(value) > 0 ? undefined : "需要正整数";

const httpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : "需要 http(s):// 开头的地址";
  } catch {
    return "不是合法的 URL";
  }
};

export const CONFIG_FIELDS: ConfigField[] = [
  {
    key: "BRIDGE_HOST",
    alias: "host",
    label: "监听地址",
    hint: "127.0.0.1 仅本机；0.0.0.0 允许局域网/Tailscale 的手机直连；也可填 Tailscale IP",
    fallback: "127.0.0.1",
    affectsCli: true,
    validate: (v) =>
      isIP(v) !== 0 || /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(v)
        ? undefined
        : "需要 IP 地址或主机名",
  },
  {
    key: "BRIDGE_PORT",
    alias: "port",
    label: "端口",
    hint: "改端口后已配对的手机需要重新扫码",
    fallback: "8787",
    affectsCli: true,
    validate: (v) => (positiveInt(v) === undefined && Number(v) <= 65535 ? undefined : "需要 1–65535 的整数"),
  },
  {
    key: "BARK_URL",
    alias: "bark",
    label: "Bark 推送",
    hint: "如 https://api.day.app/<你的 key>；审批和运行结束会推送到手机",
    fallback: "（不推送）",
    validate: httpUrl,
  },
  {
    key: "NTFY_URL",
    alias: "ntfy",
    label: "ntfy 推送",
    hint: "如 https://ntfy.sh/<topic>；与 Bark 二选一",
    fallback: "（不推送）",
    validate: httpUrl,
  },
  {
    key: "PERMISSION_TIMEOUT_MS",
    alias: "timeout",
    label: "审批超时（秒）",
    hint: "手机和终端都没处理时，超时自动拒绝",
    fallback: "300",
    seconds: true,
    validate: positiveInt,
  },
  {
    key: "ACTIVITY_COOLDOWN_MS",
    alias: "cooldown",
    label: "终端静默判定（秒）",
    hint: "终端里的会话停止输出多久后算空闲，空闲后手机才能接着发",
    fallback: "120",
    seconds: true,
    validate: positiveInt,
  },
  {
    key: "CLAUDE_BIN",
    alias: "claude",
    label: "claude 路径",
    hint: "cr open / 按 o 接管时用的 claude；留空则按 PATH 查找",
    fallback: "（PATH 中的 claude）",
    validate: (v) => (!isAbsolute(v) ? "需要绝对路径" : existsSync(v) ? undefined : "文件不存在"),
  },
  {
    key: "UPLOADS_DIR",
    alias: "uploads",
    label: "附件目录",
    hint: "手机端上传的图片/文件落盘位置",
    fallback: "~/.claude-remote/uploads",
    validate: (v) => (isAbsolute(v) ? undefined : "需要绝对路径（daemon 不展开 ~）"),
  },
];

export function findField(name: string): ConfigField | undefined {
  const lower = name.toLowerCase();
  return CONFIG_FIELDS.find((f) => f.alias === lower || f.key.toLowerCase() === lower);
}

export interface ConfigValue {
  field: ConfigField;
  /** 展示单位下的当前值；未设置为 undefined。 */
  value: string | undefined;
}

function toDisplay(field: ConfigField, stored: string): string {
  if (!field.seconds) return stored;
  const ms = Number(stored);
  return Number.isFinite(ms) ? String(Math.round(ms / 1000)) : stored;
}

export function readConfig(envFile: string): ConfigValue[] {
  const dotenv = readDotenv(envFile);
  return CONFIG_FIELDS.map((field) => {
    const stored = dotenv[field.key];
    return { field, value: stored === undefined || stored === "" ? undefined : toDisplay(field, stored) };
  });
}

/** 从 .env 文本里删掉某个键（所有同名行）。 */
export function removeDotenvKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = text.split(/\r?\n/).filter((line) => !pattern.test(line));
  const joined = lines.join("\n").replace(/\n+$/, "");
  return joined === "" ? "" : `${joined}\n`;
}

function readText(envFile: string): string {
  return existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
}

function writeText(envFile: string, text: string): void {
  writeFileSync(envFile, text, { mode: 0o600 });
  chmodSync(envFile, 0o600); // mode 只在新建文件时生效；.env 里有 token，已有文件也收紧权限
}

/**
 * 设置一项（value 为展示单位；空字符串 = 恢复默认，即从 .env 删除）。
 * 校验失败抛错，错误信息可直接展示给用户。
 */
export function setConfig(envFile: string, field: ConfigField, raw: string): void {
  const value = raw.trim();
  const text = readText(envFile);
  if (value === "") {
    writeText(envFile, removeDotenvKey(text, field.key));
    return;
  }
  const error = field.validate(value);
  if (error !== undefined) throw new Error(`${field.label}：${error}`);
  const stored = field.seconds ? String(Number(value) * 1000) : value;
  writeText(envFile, upsertDotenv(text, field.key, stored));
}

/** 生成新 token 写入 .env，返回新 token。已配对的手机/浏览器会全部失效。 */
export function rotateToken(envFile: string): string {
  const token = generateToken();
  writeText(envFile, upsertDotenv(readText(envFile), "BRIDGE_TOKEN", token));
  return token;
}
