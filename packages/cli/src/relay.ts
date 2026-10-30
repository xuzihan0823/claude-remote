// cr relay：RELAY_* 由这里管理，设备身份由所有 relay 共用。

import { isRelaySecret, MIN_RELAY_SECRET_LENGTH, normalizeRelayUrl, relayBase, relayConfigIndexes } from "@claude-remote/daemon/config";
import { deriveDeviceId, generateDeviceKey, isDeviceKey } from "@claude-remote/relay/protocol";

import { ApiError, type ConnectInfo, type RelayStatus } from "./api.js";
import { editEnvFile, removeDotenvKey } from "./config.js";
import { readDotenv, upsertDotenv } from "./env.js";
import { relativeTime } from "./format.js";

function relayKeys(dotenv: Record<string, string>): string[] {
  return Object.keys(dotenv).filter((key) => /^RELAY_(?:(?:URL|SECRET)(?:_\d+)?|DEVICE_ID|DEVICE_KEY|ENABLED)$/.test(key));
}

const DEFINITIVE_ERRORS = new Set(["auth", "device_key_mismatch", "invalid_device", "forbidden", "replaced"]);

export const RELAY_USAGE = `用法：
  cr relay add <relay 地址> <密钥>   追加 relay；地址已存在时更新密钥
  cr relay status                    逐条查看连接状态与手机地址
  cr relay on | off                  全部启用 / 临时停用（保留配置）
  cr relay remove <relay 地址>       删除一个 relay，保留设备私钥
  cr relay remove --all               删除全部配置（含设备私钥）
  cr relay remove                    仅一个 relay 时删除全部；多个时须指定地址
`;

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

export interface RelayFileState {
  configured: boolean;
  enabled: boolean;
  relays: { url: string; base?: string }[];
}

function relayEntries(dotenv: Record<string, string>): { url: string; secret: string }[] {
  const urls = new Set<string>();
  return relayConfigIndexes(dotenv).map((index) => {
    const suffix = index === 1 ? "" : `_${index}`;
    const rawUrl = dotenv[`RELAY_URL${suffix}`];
    const secret = dotenv[`RELAY_SECRET${suffix}`];
    if (!rawUrl || !secret) throw new Error(`relay ${index}：地址和密钥必须同时配置`);
    const url = parseRelayUrl(rawUrl);
    checkRelaySecret(secret);
    if (urls.has(url)) throw new Error(`relay ${index}：地址重复 ${url}`);
    urls.add(url);
    return { url, secret };
  });
}

export function readRelayFile(envFile: string): RelayFileState {
  const dotenv = readDotenv(envFile);
  const deviceId = dotenv.RELAY_DEVICE_ID;
  const relays = relayEntries(dotenv).map(({ url }) => ({ url, ...(deviceId ? { base: relayBase({ url, deviceId }) } : {}) }));
  return { configured: relays.length > 0, enabled: relays.length > 0 && (dotenv.RELAY_ENABLED || "on") !== "off", relays };
}

function writeRelayEntries(text: string, dotenv: Record<string, string>, entries: { url: string; secret: string }[]): string {
  let result = relayKeys(dotenv).filter((key) => /^RELAY_(URL|SECRET)(?:_\d+)?$/.test(key))
    .reduce((acc, key) => removeDotenvKey(acc, key), text);
  for (const [offset, entry] of entries.entries()) {
    const suffix = offset === 0 ? "" : `_${offset + 1}`;
    result = upsertDotenv(result, `RELAY_URL${suffix}`, entry.url);
    result = upsertDotenv(result, `RELAY_SECRET${suffix}`, entry.secret);
  }
  return result;
}

/** 追加或更新地址；已有合法设备私钥时始终复用。 */
export function writeRelayConfig(envFile: string, url: string, secret: string): { deviceId: string; reusedKey: boolean } {
  const dotenv = readDotenv(envFile);
  const entries = relayEntries(dotenv);
  const index = entries.findIndex((entry) => entry.url === url);
  if (index < 0) entries.push({ url, secret });
  else entries[index] = { url, secret };
  const existing = dotenv.RELAY_DEVICE_KEY;
  const reusedKey = isDeviceKey(existing);
  const deviceKey = reusedKey ? existing : generateDeviceKey();
  const deviceId = deriveDeviceId(deviceKey);
  editEnvFile(envFile, (text) => {
    let result = writeRelayEntries(text, dotenv, entries);
    for (const [key, value] of Object.entries({ RELAY_DEVICE_ID: deviceId, RELAY_DEVICE_KEY: deviceKey, RELAY_ENABLED: "on" })) {
      result = upsertDotenv(result, key, value);
    }
    return result;
  });
  return { deviceId, reusedKey };
}

export function setRelayEnabled(envFile: string, on: boolean): void {
  if (!readRelayFile(envFile).configured) throw new Error("还没有配置 relay，先 cr relay add <地址> <密钥>");
  editEnvFile(envFile, (text) => upsertDotenv(text, "RELAY_ENABLED", on ? "on" : "off"));
}

/** 不传地址时清除全部配置；指定地址时只删除该项并重排编号。 */
export function removeRelayConfig(envFile: string, url?: string): boolean {
  const dotenv = readDotenv(envFile);
  if (url === undefined) {
    const keys = relayKeys(dotenv);
    if (keys.length === 0) return false;
    editEnvFile(envFile, (text) => keys.reduce((acc, key) => removeDotenvKey(acc, key), text));
  } else {
    const entries = relayEntries(dotenv);
    const remaining = entries.filter((entry) => entry.url !== url);
    if (remaining.length === entries.length) throw new Error(`未配置 relay：${url}`);
    editEnvFile(envFile, (text) => writeRelayEntries(text, dotenv, remaining));
  }
  return true;
}

export function describeRelayError(code: string | undefined): string {
  switch (code) {
    case "auth": return "relay 密钥错误（与服务器的 RELAY_SECRET 不一致）";
    case "device_key_mismatch": return "设备私钥与设备 ID 不匹配（重新 cr relay add）";
    case "invalid_device": return "设备 ID 或私钥格式不对（重新 cr relay add）";
    case "forbidden": return "relay 拒绝接入（HTTP 403）";
    case "replaced": return "同一设备 ID 在别处接入了 relay（两台 Mac 用了同一份配置？）";
    case "unreachable": return "连不上 relay（检查网络、地址与证书）";
    case "protocol_error": return "relay 协议错误（relay 与 daemon 版本不一致？）";
    default: return code?.startsWith("http_") ? `relay 返回 HTTP ${code.slice(5)}` : (code ?? "未知错误");
  }
}

function relayDetail(status: RelayStatus, now: number): string {
  const since = status.since === undefined ? "" : `（${relativeTime(status.since, now)}）`;
  switch (status.state) {
    case "connected": return `已连接${since}`;
    case "connecting": return `连接中${since}`;
    case "error": return `${describeRelayError(status.error)}${since}`;
    case "disabled": return "已停用";
  }
}

export function relayLine(statuses: RelayStatus[] | undefined, file: RelayFileState, now = Date.now()): string {
  const active = statuses?.filter((status) => status.state !== "disabled") ?? [];
  if (!file.configured && active.length === 0) return "未配置（cr relay add <地址> <密钥>）";
  if (statuses === undefined) return `${file.enabled ? "已配置" : "已停用"}，daemon 未运行`;
  if (active.length === 0) return file.enabled ? "配置已写入，daemon 尚未加载（重启 daemon 生效）" : "已停用（cr relay on 恢复）";
  const connected = active.filter((status) => status.state === "connected").length;
  const total = new Set([...file.relays.map((entry) => entry.base ?? entry.url), ...active.map((status, index) => status.base ?? `relay ${index + 1}`)]).size;
  const details = active.flatMap((status, index) => status.state === "error" ? [`${status.base ?? `relay ${index + 1}`}：${relayDetail(status, now)}`] : []);
  if (!file.enabled || file.relays.some((entry) => !active.some((status) => status.base === entry.base))
    || active.some((status) => !file.relays.some((entry) => entry.base === status.base))) {
    details.push("配置已写入，daemon 尚未加载（重启 daemon 生效）");
  }
  return `${connected}/${total} 已连接${details.length ? `；${details.join("；")}` : connected < total ? "（其余连接中）" : ""}`;
}

export function snapshotRelayLine(
  snap: { reachable: boolean; unauthorized?: boolean; connect?: { relays: RelayStatus[] }; relayFile?: RelayFileState } | undefined,
  file: RelayFileState,
  now = Date.now(),
): string {
  const live = snap !== undefined && snap.reachable && snap.unauthorized !== true;
  return relayLine(live ? (snap.connect?.relays ?? []) : undefined, snap?.relayFile ?? file, now);
}

export type RestartResult = { kind: "restarted" } | { kind: "unhealthy" } | { kind: "skipped"; note: string };

export interface RelayDeps {
  envFile: string;
  out: (line: string) => void;
  fetch: typeof fetch;
  restart: () => Promise<RestartResult>;
  connectInfo: () => Promise<ConnectInfo>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

type Expectation = { kind: "connected"; bases: string[] } | { kind: "disconnected"; bases?: string[] };
type WaitResult =
  | { kind: "done"; statuses: RelayStatus[] }
  | { kind: "error"; status: RelayStatus }
  | { kind: "pending" }
  | { kind: "old_daemon" }
  | { kind: "no_daemon" };

async function waitForRelay(deps: RelayDeps, expect: Expectation): Promise<WaitResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? 15_000);
  let last: WaitResult = { kind: "no_daemon" };
  for (;;) {
    try {
      const { relays } = await deps.connectInfo();
      if (!Array.isArray(relays)) return { kind: "old_daemon" };
      const targets = relays.filter((status) => expect.bases === undefined || expect.bases.includes(status.base ?? ""));
      if (expect.kind === "disconnected") {
        if (targets.every((status) => status.state === "disabled")) return { kind: "done", statuses: targets };
      } else {
        if (expect.bases.length > 0 && expect.bases.every((base) => targets.some((status) => status.base === base && status.state === "connected"))) {
          return { kind: "done", statuses: targets };
        }
        const error = targets.find((status) => status.state === "error");
        if (error !== undefined) {
          last = { kind: "error", status: error };
          if (DEFINITIVE_ERRORS.has(error.error ?? "")) return last;
        } else last = { kind: "pending" };
      }
      if (expect.kind === "disconnected") last = { kind: "pending" };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: "old_daemon" };
      last = { kind: "no_daemon" };
    }
    if (now() >= deadline) return last;
    await sleep(500);
  }
}

async function applyRelay(deps: RelayDeps, expect: Expectation): Promise<number> {
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
      if (expect.kind === "connected") {
        for (const status of result.statuses) deps.out(`✓ 已连接 relay，手机地址 ${status.base ?? ""}`.trimEnd());
      } else deps.out("✓ daemon 已断开指定 relay，直连不受影响");
      return 0;
    case "error":
      deps.out(`✗ ${result.status.base ?? "relay"}：${describeRelayError(result.status.error)}`);
      return 1;
    case "pending":
      deps.out(expect.kind === "connected" ? "✗ 15 秒内没有连上目标 relay，稍后用 cr relay status 查看（配置未生效时检查 cr logs）" : "✗ daemon 仍在使用 relay（进程环境里的 RELAY_* 会覆盖配置文件，看看 cr logs）");
      return 1;
    case "old_daemon":
      deps.out("✗ 配置已写入，daemon 尚未加载（版本过旧，更新后重启 daemon 生效）");
      return 1;
    case "no_daemon":
      deps.out("✗ daemon 没有响应（cr status 看看）");
      return 1;
  }
}

async function relayStatus(deps: RelayDeps): Promise<number> {
  const file = readRelayFile(deps.envFile);
  let statuses: RelayStatus[] | undefined;
  try {
    statuses = (await deps.connectInfo()).relays ?? [];
  } catch {
    statuses = undefined;
  }
  const now = deps.now?.() ?? Date.now();
  deps.out(`开关     ${file.enabled ? "on" : "off"}`);
  const entries = [...file.relays];
  for (const status of statuses ?? []) {
    if (status.base !== undefined && !entries.some((entry) => entry.base === status.base)) {
      entries.push({ url: status.base.replace(/\/d\/[^/]+$/, ""), base: status.base });
    }
  }
  for (const [index, entry] of entries.entries()) {
    deps.out(`relay ${index + 1}  ${entry.url}`);
    if (entry.base !== undefined) deps.out(`手机地址 ${entry.base}`);
    const status = statuses?.find((candidate) => entry.base !== undefined && candidate.base === entry.base);
    deps.out(`状态     ${status === undefined ? relayLine(statuses === undefined ? undefined : [], { ...file, configured: true, relays: [entry] }, now) : relayDetail(status, now)}`);
  }
  deps.out(`汇总     ${relayLine(statuses, file, now)}`);
  return 0;
}

export async function runRelay(args: string[], deps: RelayDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const [rawUrl, secret] = rest;
      if (rest.length !== 2 || rawUrl === undefined || secret === undefined) throw new Error("用法：cr relay add <relay 地址> <密钥>");
      const url = parseRelayUrl(rawUrl);
      checkRelaySecret(secret);
      const previous = readRelayFile(deps.envFile);
      deps.out(`… 检查 ${url}`);
      await probeRelay(url, deps.fetch);
      deps.out("✓ relay 在线");
      const { deviceId, reusedKey } = writeRelayConfig(deps.envFile, url, secret);
      deps.out(`✓ 已写入配置（设备 ID ${deviceId}，${reusedKey ? "沿用已有设备私钥" : "已生成设备私钥"}）`);
      if (previous.relays.some((entry) => entry.url !== url)) deps.out("已有其他 relay；如需替换，用 cr relay remove <旧地址>");
      const code = await applyRelay(deps, { kind: "connected", bases: [relayBase({ url, deviceId })] });
      if (code === 0) deps.out("已配对的手机下次完整连接这台 Mac 时会同步 relay 地址；新手机用 cr pair 扫码");
      return code;
    }
    case "status":
    case undefined:
      if (rest.length) throw new Error("用法：cr relay status");
      return relayStatus(deps);
    case "on":
    case "off": {
      if (rest.length) throw new Error("用法：cr relay on | off");
      setRelayEnabled(deps.envFile, sub === "on");
      deps.out(sub === "on" ? "✓ relay 已启用" : "✓ relay 已停用（配置保留，cr relay on 恢复）");
      return applyRelay(deps, sub === "on"
        ? { kind: "connected", bases: readRelayFile(deps.envFile).relays.flatMap((entry) => entry.base === undefined ? [] : [entry.base]) }
        : { kind: "disconnected" });
    }
    case "remove": {
      if (rest.length > 1) throw new Error("用法：cr relay remove <地址> | --all");
      const target = rest[0];
      const file = target === "--all" ? undefined : readRelayFile(deps.envFile);
      if (target === undefined && file!.relays.length > 1) {
        throw new Error(`已配置多个 relay，请指定 cr relay remove <地址> 或 remove --all：\n${file!.relays.map((entry) => entry.url).join("\n")}`);
      }
      const url = target === undefined || target === "--all" ? undefined : parseRelayUrl(target);
      if (!removeRelayConfig(deps.envFile, url)) {
        deps.out("relay 未配置，无需移除");
        return 0;
      }
      deps.out(url === undefined ? "✓ 已删除全部 RELAY_* 配置（含设备私钥；再次 add 会得到新的设备 ID，手机需重新同步或扫码）" : `✓ 已删除 ${url}，保留设备 ID 和设备私钥`);
      const base = file?.relays.find((entry) => entry.url === url)?.base;
      return applyRelay(deps, { kind: "disconnected", ...(base === undefined ? {} : { bases: [base] }) });
    }
    default:
      deps.out(RELAY_USAGE);
      return 2;
  }
}
