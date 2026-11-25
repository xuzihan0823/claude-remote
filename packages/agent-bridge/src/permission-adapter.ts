import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { InteractionDecision, PermissionMetadata, PlanApproval } from "./types.js";

export interface PermissionRequest extends PermissionMetadata {
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

const RULE_ACTIONS = { addRules: "Add", replaceRules: "Replace", removeRules: "Remove" };

function describeUpdate(update: PermissionUpdate): string {
  switch (update.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules": {
      const rules = update.rules.map(({ toolName, ruleContent }) =>
        ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`);
      return `${RULE_ACTIONS[update.type]} ${update.behavior} rules: ${rules.join(", ")}`;
    }
    case "setMode":
      return `Set permission mode to ${update.mode}`;
    case "addDirectories":
    case "removeDirectories":
      return `${update.type === "addDirectories" ? "Add" : "Remove"} directories: ${update.directories.join(", ")}`;
  }
  throw new TypeError("Unsupported SDK permission suggestion");
}

function planFromInput(input: Record<string, unknown>): PlanApproval {
  const plan: PlanApproval = {};
  if (typeof input.plan === "string") plan.text = input.plan;
  if (typeof input.planFilePath === "string") plan.filePath = input.planFilePath;
  else if (typeof input.filePath === "string") plan.filePath = input.filePath;
  if (Array.isArray(input.allowedPrompts)) {
    plan.allowedPrompts = [];
    for (const value of input.allowedPrompts as unknown[]) {
      if (typeof value === "object" && value !== null &&
          "tool" in value && typeof value.tool === "string" && "prompt" in value && typeof value.prompt === "string") {
        plan.allowedPrompts.push({ tool: value.tool, prompt: value.prompt });
      }
    }
  }
  return plan;
}

export function createPermissionAdapter(
  broker: PermissionBroker,
  context: { sessionKey: string; userId: string },
  options: PermissionAdapterOptions = {},
): CanUseTool {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  return async (toolName, input, sdkOptions): Promise<PermissionResult> => {
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([sdkOptions.signal, options.signal]) : sdkOptions.signal;
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("permission decision timed out")), timeoutMs);
    timer.unref();
    try {
      if (signal.aborted) return { behavior: "deny", message: "Permission denied: request cancelled" };
      const { requestId, decisionReason, blockedPath, agentID, toolUseID, title } = sdkOptions;
      const updates = sdkOptions.suggestions?.map((update, index) => ({
        id: `${requestId}:${index}`,
        update: structuredClone(update),
      }));
      const decision = await Promise.race([
        broker.request({
          requestId,
          sessionKey: context.sessionKey,
          userId: context.userId,
          kind: toolName === "AskUserQuestion" ? "question" : "approval",
          toolName,
          input,
          prompt: title ?? `Claude requests tool ${toolName}\n\n${JSON.stringify(input, null, 2)}`,
          ...(updates === undefined ? {} : { suggestions: updates.map(({ id, update }) => ({
            id, destination: update.destination, type: update.type, description: describeUpdate(update),
          })) }),
          ...(decisionReason === undefined ? {} : { decisionReason }),
          ...(blockedPath === undefined ? {} : { blockedPath }),
          ...(agentID === undefined ? {} : { agentId: agentID }),
          ...(toolUseID === undefined ? {} : { toolUseId: toolUseID }),
          ...(toolName === "ExitPlanMode" ? { plan: planFromInput(input) } : {}),
        }, controller.signal),
        new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = (): void => reject(controller.signal.reason ?? new Error("permission aborted"));
          if (controller.signal.aborted) rejectOnAbort();
          else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
      ]);
      if (Date.now() >= deadline) return { behavior: "deny", message: "Permission decision timed out" };
      if (controller.signal.aborted) return { behavior: "deny", message: "Permission denied: request cancelled" };
      if (decision.type === "allow_once") {
        const { applySuggestionIds } = decision;
        if (applySuggestionIds === undefined || (Array.isArray(applySuggestionIds) && applySuggestionIds.length === 0)) {
          return { behavior: "allow", updatedInput: input };
        }
        if (!Array.isArray(applySuggestionIds) || toolName === "AskUserQuestion" || updates === undefined) {
          return { behavior: "deny", message: "Invalid permission suggestion selection" };
        }
        const ids = new Set(applySuggestionIds);
        const selected = updates.filter(({ id }) => ids.has(id));
        if (selected.length !== applySuggestionIds.length) {
          return { behavior: "deny", message: "Invalid permission suggestion selection" };
        }
        return { behavior: "allow", updatedInput: input, updatedPermissions: selected.map(({ update }) => update) };
      }
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
