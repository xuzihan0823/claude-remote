import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { InteractionDecision } from "./types.js";

export interface PermissionRequest {
  requestId: string;
  sessionKey: string;
  userId: string;
  kind: "approval" | "question";
  toolName: string;
  input: Record<string, unknown>;
  prompt: string;
}

export interface PermissionBroker {
  request(request: PermissionRequest, signal: AbortSignal): Promise<InteractionDecision>;
}

export interface PermissionAdapterOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createPermissionAdapter(
  broker: PermissionBroker,
  context: { sessionKey: string; userId: string },
  options: PermissionAdapterOptions = {},
): CanUseTool {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  return async (toolName, input, sdkOptions): Promise<PermissionResult> => {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([sdkOptions.signal, options.signal]) : sdkOptions.signal;
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("permission decision timed out")), timeoutMs);
    timer.unref();
    try {
      if (signal.aborted) abort();
      const decision = await Promise.race([
        broker.request({
          requestId: sdkOptions.requestId,
          sessionKey: context.sessionKey,
          userId: context.userId,
          kind: toolName === "AskUserQuestion" ? "question" : "approval",
          toolName,
          input,
          prompt: sdkOptions.title ?? `Claude requests tool ${toolName}\n\n${JSON.stringify(input, null, 2)}`,
        }, controller.signal),
        new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = (): void => reject(controller.signal.reason ?? new Error("permission aborted"));
          if (controller.signal.aborted) rejectOnAbort();
          else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
      ]);
      if (controller.signal.aborted) return { behavior: "deny", message: "Permission denied: request cancelled" };
      if (decision.type === "allow_once") return { behavior: "allow", updatedInput: input };
      if (decision.type === "answer" && toolName === "AskUserQuestion") {
        return { behavior: "allow", updatedInput: { ...input, answers: decision.answers } };
      }
      return { behavior: "deny", message: decision.type === "deny" ? decision.message ?? "User denied this action" : "Invalid permission decision" };
    } catch {
      return { behavior: "deny", message: "Permission denied: no confirmed Gateway decision" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
}
