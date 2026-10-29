import { EFFORT_LEVELS, resolveSettings, type EffortLevel } from "@claude-remote/agent-bridge";

export interface EffortOptions {
  levels: EffortLevel[];
  /** true：档位来自本机 Magpie 网关的 /v1/models；false：无从确认，五档全部开放。 */
  verified: boolean;
}

const ALIAS_ENV: Record<string, string> = {
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const normalize = (s: string): string => s.toLowerCase().replace(/\[1m\]$/, "");
const unverified = (): EffortOptions => ({ levels: [...EFFORT_LEVELS], verified: false });

// model 省略时按 Claude Code 的优先级取默认模型：ANTHROPIC_MODEL 环境变量 > settings.model
export async function readEffortOptions(cwd: string, model?: string, request: typeof fetch = fetch): Promise<EffortOptions> {
  try {
    const { effective } = await resolveSettings({ cwd });
    const env: Record<string, unknown> = { ...process.env, ...record(effective.env) };
    let target = model ?? text(env.ANTHROPIC_MODEL) ?? text(effective.model);
    const aliasKey = target === undefined ? undefined : ALIAS_ENV[target];
    if (aliasKey !== undefined) target = text(env[aliasKey]) ?? target;
    const base = text(env.ANTHROPIC_BASE_URL);
    if (target === undefined || base === undefined) return unverified();
    const url = new URL(base);
    if (!LOOPBACK.has(url.hostname) || url.protocol !== "http:") return unverified();
    const response = await request(new URL("/v1/models", url), { signal: AbortSignal.timeout(2_000), redirect: "error" });
    if (!response.ok) return unverified();
    const data = record(await response.json()).data;
    const wanted = normalize(target);
    const found = Array.isArray(data) ? data.map(record).find((m) => typeof m.id === "string" && normalize(m.id) === wanted) : undefined;
    const supported = found?.reasoning_levels;
    if (!found || !Array.isArray(supported)) return unverified();
    const levels = EFFORT_LEVELS.filter((l) => supported.includes(l));
    // Magpie 对自定义渠道的模型一律报 reasoning:false、档位为空，只说明网关不知道，不代表模型不支持
    return levels.length > 0 ? { levels, verified: true } : unverified();
  } catch {
    return unverified();
  }
}
