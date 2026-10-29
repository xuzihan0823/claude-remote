import { createHmac, randomBytes } from "node:crypto";
import { EFFORT_LEVELS, queryModelCapabilities, resolveSettings, type EffortLevel } from "@claude-remote/agent-bridge";

type ModelInfo = Awaited<ReturnType<typeof queryModelCapabilities>>[number];
export interface ModelCapabilities {
  status: "known" | "unknown" | "unsupported";
  effortLevels: EffortLevel[];
  source: "claude" | "magpie" | "unknown";
  revision: string;
  thinkingEnabled?: boolean;
  reason?: string;
}
interface Snapshot {
  revision: string;
  env: Record<string, unknown>;
  thinkingEnabled: boolean;
  effortLocked: boolean;
}
const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const normalize = (s: string): string => s.toLowerCase().replace(/\[1m\]/g, "");
const levelsOf = (v: unknown): EffortLevel[] => EFFORT_LEVELS.filter((l) => Array.isArray(v) && v.includes(l));

export class ModelCapabilityService {
  readonly #salt = randomBytes(32);
  readonly #cache = new Map<string, { time: number; result: Promise<ModelInfo[]> }>();
  constructor(readonly queryModels = queryModelCapabilities, readonly request: typeof fetch = fetch) {}

  async #snapshot(cwd: string): Promise<Snapshot> {
    const { effective: settings, sources } = await resolveSettings({ cwd });
    const env: Record<string, unknown> = { ...process.env, ...record(settings.env) };
    const budget = env.MAX_THINKING_TOKENS;
    const thinkingEnabled = budget !== undefined && budget !== "" ? Number(budget) > 0 : settings.alwaysThinkingEnabled !== false;
    return {
      env, thinkingEnabled,
      revision: createHmac("sha256", this.#salt).update(JSON.stringify([cwd, sources, process.env])).digest("hex"),
      effortLocked: typeof env.CLAUDE_CODE_EFFORT_LEVEL === "string" && env.CLAUDE_CODE_EFFORT_LEVEL !== "",
    };
  }

  async get(cwd: string, model?: string, refresh = false): Promise<ModelCapabilities> {
    let snapshot: Snapshot;
    try { snapshot = await this.#snapshot(cwd); }
    catch { return { status: "unknown", effortLevels: [], source: "unknown", revision: "", reason: "settings_unavailable" }; }
    const key = snapshot.revision;
    const base = { revision: key, thinkingEnabled: snapshot.thinkingEnabled };
    if (snapshot.effortLocked) return { ...base, status: "unsupported", effortLevels: [], source: "claude", reason: "effort_env_override" };
    let entry = this.#cache.get(key);
    if (!entry || refresh || Date.now() - entry.time > 30_000) {
      entry = { time: Date.now(), result: this.queryModels(cwd) };
      this.#cache.set(key, entry);
      if (this.#cache.size > 32) this.#cache.delete(this.#cache.keys().next().value!);
    }
    let models: ModelInfo[];
    try { models = await entry.result; }
    catch { this.#cache.delete(key); return { ...base, status: "unknown", effortLevels: [], source: "unknown", reason: "query_failed" }; }
    const selected = model === undefined ? models.find((m) => m.value === "default")
      : models.find((m) => m.value === model) ?? models.find((m) => normalize(m.resolvedModel || m.value) === normalize(model));
    if (!selected) return { ...base, status: "unknown", effortLevels: [], source: "unknown", reason: "model_not_reported" };
    let levels = levelsOf(selected.supportedEffortLevels);
    let status: ModelCapabilities["status"] = selected.supportsEffort === false ? "unsupported" : levels.length > 0 ? "known" : "unknown";
    let source: ModelCapabilities["source"] = "claude";
    const gateway = await this.#magpie(snapshot.env, selected.resolvedModel || selected.value);
    if (gateway) {
      source = "magpie";
      if (gateway.reasoning === false) { status = "unsupported"; levels = []; }
      else if (gateway.levels.length > 0) {
        levels = levels.filter((l) => gateway.levels.includes(l));
        status = levels.length > 0 ? "known" : "unknown";
      }
    }
    if (status === "unsupported") levels = [];
    return { ...base, status, effortLevels: levels, source };
  }

  async #magpie(env: Record<string, unknown>, model: string): Promise<{ reasoning?: boolean; levels: EffortLevel[] } | undefined> {
    if (typeof env.ANTHROPIC_BASE_URL !== "string") return;
    try {
      const url = new URL(env.ANTHROPIC_BASE_URL);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password) return;
      const hello = await this.request(new URL("/api/hello", url), { signal: AbortSignal.timeout(1_000), redirect: "error" });
      if (!hello.ok || record(await hello.json()).name !== "magpie") return;
      const response = await this.request(new URL("/v1/models", url), { signal: AbortSignal.timeout(2_000), redirect: "error" });
      if (!response.ok) return;
      const data = record(await response.json()).data;
      if (!Array.isArray(data)) return;
      const found = data.map(record).find((m) => typeof m.id === "string" && normalize(m.id) === normalize(model));
      if (!found) return;
      const raw = found.reasoning_levels ?? (Array.isArray(found.supported_reasoning_levels) ? found.supported_reasoning_levels.map((v) => record(v).effort) : []);
      return { ...(typeof found.reasoning === "boolean" ? { reasoning: found.reasoning } : {}), levels: levelsOf(raw) };
    } catch { return; }
  }
}
