// cr relay：把这台 Mac 接入自建 relay（design §4）。
//
// RELAY_* 只由这里读写，不进 cr config 的通用配置表，避免手改出半配置状态。
// 设备私钥只在 add 时（缺失才）生成、只在 remove 时删除：换私钥等于换设备 ID，手机上的 relay 地址会变。

import { isRelaySecret, MIN_RELAY_SECRET_LENGTH, normalizeRelayUrl, relayBase } from "@claude-remote/daemon/config";
import { deriveDeviceId, generateDeviceKey, isDeviceKey } from "@claude-remote/relay/protocol";

import { ApiError, type ConnectInfo, type RelayStatus } from "./api.js";
import { editEnvFile, removeDotenvKey } from "./config.js";
import { readDotenv, upsertDotenv } from "./env.js";
import { relativeTime } from "./format.js";

export const RELAY_KEYS = ["RELAY_URL", "RELAY_SECRET", "RELAY_DEVICE_ID", "RELAY_DEVICE_KEY", "RELAY_ENABLED"] as const;

/** 这些错误重试也没用，等待连接时直接报告。 */
const DEFINITIVE_ERRORS = new Set(["auth", "device_key_mismatch", "invalid_device", "forbidden", "replaced"]);

export const RELAY_USAGE = `用法：
  cr relay add <relay 地址> <密钥>   接入 relay（地址与密钥见服务器安装脚本最后打印的命令）
  cr relay status                    连接状态与手机用的 relay 地址
  cr relay on | off                  启用 / 临时停用（保留配置）
  cr relay remove                    删除全部 relay 配置（含设备私钥）
`;

// -- 校验 ---------------------------------------------------------------------

export function parseRelayUrl(raw: string): string {
  const url = normalizeRelayUrl(raw);
  if (url === undefined) {
    throw new Error(`relay 地址不合法：${raw}（需要 https:// 开头；http:// 只允许 localhost / 127.0.0.1 本地测试；不能带 ? 参数）`);
  }
  return url;
}

export function checkRelaySecret(secret: string): void {
  if (!isRelaySecret(secret)) throw new Error(`relay 密钥至少 ${MIN_RELAY_SECRET_LENGTH} 个字符，且不能含空格、中文、引号、# 或反斜杠`);
}

/** GET <url>/healthz，确认对面确实是 claude-remote relay。 */
export async function probeRelay(url: string, fetchImpl: typeof fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    const { cause } = error as { cause?: { code?: string; message?: string } };
    const reason = cause?.code ?? cause?.message ?? (error as Error).message;
    throw new Error(`连不上 relay ${url}（${reason}）：检查地址、端口、服务器安全组与证书`);
  }
  const body = (await res.json().catch(() => undefined)) as { ok?: unknown } | undefined;
  if (!res.ok || body?.ok !== true) {
    throw new Error(`${url} 不像 claude-remote relay（/healthz 返回 HTTP ${res.status}）`);
  }
}

// -- 配置文件 -----------------------------------------------------------------

export interface RelayFileState {
  configured: boolean;
  enabled: boolean;
  url?: string;
  base?: string;
}

export function readRelayFile(envFile: string): RelayFileState {
  const dotenv = readDotenv(envFile);
  const rawUrl = dotenv.RELAY_URL;
  const deviceId = dotenv.RELAY_DEVICE_ID;
  if (!rawUrl) return { configured: false, enabled: false };
  const url = normalizeRelayUrl(rawUrl) ?? rawUrl;
  return {
    configured: true,
    enabled: (dotenv.RELAY_ENABLED || "on") !== "off",
    url,
    ...(deviceId ? { base: relayBase({ url, deviceId }) } : {}),
  };
}

/** 写入 RELAY_*。已有合法设备私钥则复用（设备 ID 不变），否则生成。 */
export function writeRelayConfig(envFile: string, url: string, secret: string): { deviceId: string; reusedKey: boolean } {
  const existing = readDotenv(envFile).RELAY_DEVICE_KEY;
  const reusedKey = isDeviceKey(existing);
  const deviceKey = reusedKey ? existing : generateDeviceKey();
  const deviceId = deriveDeviceId(deviceKey);
  const values: Record<(typeof RELAY_KEYS)[number], string> = {
    RELAY_URL: url,
    RELAY_SECRET: secret,
    RELAY_DEVICE_ID: deviceId,
    RELAY_DEVICE_KEY: deviceKey,
    RELAY_ENABLED: "on",
  };
  editEnvFile(envFile, (text) => RELAY_KEYS.reduce((acc, key) => upsertDotenv(acc, key, values[key]), text));
  return { deviceId, reusedKey };
}

export function setRelayEnabled(envFile: string, on: boolean): void {
  if (!readRelayFile(envFile).configured) throw new Error("还没有配置 relay，先 cr relay add <地址> <密钥>");
  editEnvFile(envFile, (text) => upsertDotenv(text, "RELAY_ENABLED", on ? "on" : "off"));
}

/** 删除全部 RELAY_*（含设备私钥）。返回原先是否有任何 RELAY_* 配置。 */
export function removeRelayConfig(envFile: string): boolean {
  const dotenv = readDotenv(envFile);
  if (!RELAY_KEYS.some((key) => key in dotenv)) return false;
  editEnvFile(envFile, (text) => RELAY_KEYS.reduce((acc, key) => removeDotenvKey(acc, key), text));
  return true;
}

// -- 展示 ---------------------------------------------------------------------

export function describeRelayError(code: string | undefined): string {
  switch (code) {
    case "auth":
      return "relay 密钥错误（与服务器的 RELAY_SECRET 不一致）";
    case "device_key_mismatch":
      return "设备私钥与设备 ID 不匹配（重新 cr relay add）";
    case "invalid_device":
      return "设备 ID 或私钥格式不对（重新 cr relay add）";
    case "forbidden":
      return "relay 拒绝接入（HTTP 403）";
    case "replaced":
      return "同一设备 ID 在别处接入了 relay（两台 Mac 用了同一份配置？）";
    case "unreachable":
      return "连不上 relay（检查网络、地址与证书）";
    case "protocol_error":
      return "relay 协议错误（relay 与 daemon 版本不一致？）";
    default:
      return code?.startsWith("http_") ? `relay 返回 HTTP ${code.slice(5)}` : (code ?? "未知错误");
  }
}

/** 一行 relay 状态：cr status、cr relay status、TUI 设置页共用。status 为 undefined 表示 daemon 没在响应。 */
export function relayLine(status: RelayStatus | undefined, file: RelayFileState, now = Date.now()): string {
  if (!file.configured && (status === undefined || status.state === "disabled")) return "未配置（cr relay add <地址> <密钥>）";
  if (status === undefined) return `${file.enabled ? "已配置" : "已停用"}，daemon 未运行`;
  const base = status.base ?? file.base;
  const since = status.since === undefined ? "" : `（${relativeTime(status.since, now)}）`;
  switch (status.state) {
    case "connected":
      return `已连接${since}  ${base ?? ""}`.trimEnd();
    case "connecting":
      return `连接中${since}`;
    case "error":
      return `${describeRelayError(status.error)}${since}`;
    case "disabled":
      return file.enabled ? "配置已写入，daemon 尚未加载（重启 daemon 生效）" : "已停用（cr relay on 恢复）";
  }
}

/** 从 daemon 快照得出 relay 状态行：daemon 在跑但没有 connect-info（旧版）时按"未加载"处理。 */
export function snapshotRelayLine(
  snap: { reachable: boolean; unauthorized?: boolean; connect?: { relay: RelayStatus }; relayFile?: RelayFileState } | undefined,
  file: RelayFileState,
  now = Date.now(),
): string {
  const live = snap !== undefined && snap.reachable && snap.unauthorized !== true;
  return relayLine(live ? (snap.connect?.relay ?? { state: "disabled" }) : undefined, snap?.relayFile ?? file, now);
}

// -- 命令 ---------------------------------------------------------------------

export type RestartResult = { kind: "restarted" } | { kind: "unhealthy" } | { kind: "skipped"; note: string };

export interface RelayDeps {
  envFile: string;
  out: (line: string) => void;
  fetch: typeof fetch;
  /** 让 daemon 重新读取配置（launchd 托管时重启；其他情况返回 skipped 并说明原因）。 */
  restart: () => Promise<RestartResult>;
  /** daemon 的 /api/connect-info；daemon 不通时抛错。 */
  connectInfo: () => Promise<ConnectInfo>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 等待连上 relay 的上限。 */
  waitMs?: number;
}

type WaitResult =
  | { kind: "done"; status: RelayStatus }
  | { kind: "error"; status: RelayStatus }
  | { kind: "pending"; status: RelayStatus }
  | { kind: "old_daemon" }
  | { kind: "no_daemon" };

/** 轮询 connect-info 直到 relay 进入期望状态、出现无需再等的错误，或超时。 */
async function waitForRelay(deps: RelayDeps, expect: "connected" | "disabled"): Promise<WaitResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? 15_000);
  let last: WaitResult = { kind: "no_daemon" };
  for (;;) {
    try {
      const { relay } = await deps.connectInfo();
      if (relay.state === expect) return { kind: "done", status: relay };
      if (expect === "connected" && relay.state === "error" && DEFINITIVE_ERRORS.has(relay.error ?? "")) {
        return { kind: "error", status: relay };
      }
      last = { kind: relay.state === "error" ? "error" : "pending", status: relay };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: "old_daemon" };
      last = { kind: "no_daemon" };
    }
    if (now() >= deadline) return last;
    await sleep(500);
  }
}

/** 重启 daemon 并报告结果；返回退出码。 */
async function applyRelay(deps: RelayDeps, expect: "connected" | "disabled"): Promise<number> {
  const restarted = await deps.restart();
  if (restarted.kind === "skipped") {
    deps.out(restarted.note);
    return 0;
  }
  if (restarted.kind === "unhealthy") {
    deps.out("✗ 重启后 daemon 没有响应，看看日志：cr logs");
    return 1;
  }
  const result = await waitForRelay(deps, expect);
  switch (result.kind) {
    case "done":
      deps.out(expect === "connected" ? `✓ 已连接 relay，手机地址 ${result.status.base ?? ""}`.trimEnd() : "✓ daemon 已断开 relay，直连不受影响");
      return 0;
    case "error":
      deps.out(`✗ ${describeRelayError(result.status.error)}`);
      return 1;
    case "pending":
      deps.out(
        result.status.state === "disabled"
          ? "✗ daemon 没有启用 relay（配置没生效？进程环境里的 RELAY_* 会覆盖配置文件，看看 cr logs）"
          : expect === "connected"
            ? "✗ 15 秒内没有连上 relay，稍后用 cr relay status 查看"
            : "✗ daemon 仍在使用 relay（进程环境里的 RELAY_* 会覆盖配置文件，看看 cr logs）",
      );
      return 1;
    case "old_daemon":
      deps.out("✗ daemon 版本过旧，不支持 relay：更新后重启");
      return 1;
    case "no_daemon":
      deps.out("✗ daemon 没有响应（cr status 看看）");
      return 1;
  }
}

async function relayStatus(deps: RelayDeps): Promise<number> {
  const file = readRelayFile(deps.envFile);
  let status: RelayStatus | undefined;
  try {
    status = (await deps.connectInfo()).relay;
  } catch {
    status = undefined;
  }
  if (file.configured) {
    deps.out(`relay    ${file.url ?? ""}`);
    if (file.base !== undefined) deps.out(`手机地址 ${file.base}`);
    deps.out(`开关     ${file.enabled ? "on" : "off"}`);
  }
  deps.out(`状态     ${relayLine(status, file, deps.now?.() ?? Date.now())}`);
  return 0;
}

/** cr relay <子命令>；返回退出码。 */
export async function runRelay(args: string[], deps: RelayDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const [rawUrl, secret] = rest;
      if (rawUrl === undefined || secret === undefined) throw new Error("用法：cr relay add <relay 地址> <密钥>");
      const url = parseRelayUrl(rawUrl);
      checkRelaySecret(secret);
      deps.out(`… 检查 ${url}`);
      await probeRelay(url, deps.fetch);
      deps.out("✓ relay 在线");
      const { deviceId, reusedKey } = writeRelayConfig(deps.envFile, url, secret);
      deps.out(`✓ 已写入配置（设备 ID ${deviceId}，${reusedKey ? "沿用已有设备私钥" : "已生成设备私钥"}）`);
      const code = await applyRelay(deps, "connected");
      if (code === 0) deps.out("已配对的手机下次连上这台 Mac 时会自动同步 relay 地址；新手机用 cr pair 扫码");
      return code;
    }
    case "status":
    case undefined:
      return relayStatus(deps);
    case "on":
    case "off":
      setRelayEnabled(deps.envFile, sub === "on");
      deps.out(sub === "on" ? "✓ relay 已启用" : "✓ relay 已停用（配置保留，cr relay on 恢复）");
      return applyRelay(deps, sub === "on" ? "connected" : "disabled");
    case "remove":
      if (!removeRelayConfig(deps.envFile)) {
        deps.out("relay 未配置，无需移除");
        return 0;
      }
      deps.out("✓ 已删除全部 RELAY_* 配置（含设备私钥；再次 add 会得到新的设备 ID，手机需重新同步或扫码）");
      return applyRelay(deps, "disabled");
    default:
      deps.out(RELAY_USAGE);
      return 2;
  }
}
