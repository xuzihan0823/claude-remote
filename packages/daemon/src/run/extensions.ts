import type { SdkQueryHandle } from "@claude-remote/agent-bridge";
import type { CommandCatalog } from "./p1.js";

type Servers = Awaited<ReturnType<SdkQueryHandle["mcpServerStatus"]>>;
type Server = Pick<Servers[number], "name" | "status">;
export type Plugin = { name: string };
export type ExtensionAction = { type: "read" | "reload" } | { type: "reconnect"; name: string } |
  { type: "toggle"; name: string; enabled: boolean };
export type ExtensionRequest = Exclude<ExtensionAction, { type: "toggle" }> | { type: "toggle"; name: string };
export type ExtensionResult =
  | { status: "available"; runId: string; mcp: Server[]; plugins: Plugin[]; commands?: CommandCatalog }
  | { status: "available"; runId: string; server: Server }
  | { status: "unavailable"; reason: "no_active_sdk" | "terminal_driving" | "session_changed" | "run_mismatch" |
      "extension_busy" | "sdk_unavailable" | "initializing" | "session_toggle_unsupported" | "server_not_found" };

export function validExtensionName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\p{Cc}/u.test(value);
}

export function safePlugins(plugins: Plugin[]): Plugin[] {
  return plugins.flatMap((p) => validExtensionName(p?.name) ? [{ name: p.name }] : []);
}

export function safeServers(servers: Servers): Server[] {
  return servers.flatMap((s) => validExtensionName(s?.name) && ["connected", "failed", "needs-auth", "pending", "disabled"].includes(s.status)
    ? [{ name: s.name, status: s.status }] : []);
}
