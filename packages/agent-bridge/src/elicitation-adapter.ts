import type { ElicitationRequest, ElicitationResult, OnElicitation } from "@anthropic-ai/claude-agent-sdk";

import type { PermissionAdapterOptions } from "./permission-adapter.js";

type ElicitationPayload = Pick<ElicitationRequest, "serverName" | "message" | "elicitationId"> & (
  | { mode: "form"; requestedSchema: Record<string, unknown> }
  | { mode: "url"; url: string; elicitationId: string }
);

type ElicitationContext = { sessionKey: string; runId: string; userId: string };
export interface ElicitationBroker {
  requestElicitation(
    request: ElicitationContext & { payload: ElicitationPayload }, signal: AbortSignal,
  ): Promise<{ action: ElicitationResult["action"]; content?: Record<string, unknown> }>;
}

export function isElicitationContent(value: unknown): value is NonNullable<ElicitationResult["content"]> {
  return isObject(value) && Object.values(value).every((field) =>
    typeof field === "string" || typeof field === "boolean" || Number.isFinite(field) ||
    (Array.isArray(field) && field.every((item: unknown) => typeof item === "string")));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || /[\s\p{Cc}\\]/u.test(value)) return false;
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes("@")) return false;
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
}

function projectRequest(request: ElicitationRequest): ElicitationPayload | undefined {
  const { serverName, message, mode = "form", elicitationId, requestedSchema, url } = request;
  if (typeof serverName !== "string" || !serverName.trim() || /\p{Cc}/u.test(serverName) ||
    typeof message !== "string" || !message.trim() ||
    (elicitationId !== undefined && (typeof elicitationId !== "string" || !elicitationId.trim() || /\p{Cc}/u.test(elicitationId)))) return undefined;

  if (mode === "url" && elicitationId !== undefined && isAuthorizationUrl(url)) {
    return { mode, serverName, message, url, elicitationId };
  }
  if (mode === "form" && isObject(requestedSchema)) {
    const schema: unknown = JSON.parse(JSON.stringify(requestedSchema));
    if (isObject(schema)) return { mode, serverName, message, requestedSchema: schema, ...(elicitationId === undefined ? {} : { elicitationId }) };
  }
  return undefined;
}

export function createElicitationAdapter(
  broker: ElicitationBroker,
  context: ElicitationContext,
  options: PermissionAdapterOptions = {},
): OnElicitation {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  return async (request, sdkOptions) => {
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const signal = AbortSignal.any([sdkOptions.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    let onAbort!: () => void;
    const cancelled = new Promise<undefined>((resolve) => { onAbort = () => resolve(undefined); });
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    try {
      if (signal.aborted) return { action: "cancel" };
      const payload = projectRequest(request);
      if (!payload || Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024 || Date.now() >= deadline) return { action: "cancel" };
      const result = await Promise.race([broker.requestElicitation({ ...context, payload }, signal), cancelled]);
      if (signal.aborted || Date.now() >= deadline || !result) return { action: "cancel" };
      if (result.action === "decline") return { action: "decline" };
      if (result.action !== "accept") return { action: "cancel" };
      if (result.content === undefined) return { action: "accept" };
      if (payload.mode === "form" && isElicitationContent(result.content)) return { action: "accept", content: result.content };
      return { action: "cancel" };
    } catch {
      return { action: "cancel" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}
