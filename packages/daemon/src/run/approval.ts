// PermissionBroker → interactions 状态机 → WS 审批卡片的桥。
//
// 两侧的失败纪律不同：SDK 侧（request）fail-closed——任何异常一律折算成 deny；
// HTTP 侧（decide）永不抛裸异常——已解决/不存在/类型不匹配全部转成结构化结果
// （旧项目审查教训：双击按钮不得 500）。
//
// 超时 auto-deny 与重启 auto-deny 由 interactions 包既有逻辑负责；本模块只在
// awaitDecision 返回后按落库状态补发 approval.resolved（含 expired）。

import type { InteractionDecision, PermissionBroker, PermissionMetadata, PermissionRequest } from "@claude-remote/agent-bridge";
import {
  InteractionAlreadyResolvedError,
  InteractionManager,
  InteractionNotFoundError,
  InteractionTypeError,
  InteractionUnauthorizedError,
  InvalidInteractionAnswerError,
  InvalidPermissionSuggestionError,
  questionFromAskUserInput,
  type Approval,
  type Decision,
  type InteractionRecord,
  type Question,
  type QuestionItem,
} from "@claude-remote/interactions";

export type ResolvedStatus = "allowed" | "denied" | "answered" | "expired";

/** WS `approval` 帧的 interaction 载荷（见 docs/architecture.md）。 */
export interface ApprovalCard extends PermissionMetadata {
  interactionId: string;
  sessionId: string;
  kind: "approval" | "question";
  toolName: string;
  input: Record<string, unknown>;
  prompt: string;
  expiresAt: number;
  /** kind=question 时为拆分后的单题。 */
  questions?: QuestionItem[];
}

export type ApprovalEvent =
  | { type: "approval"; interaction: ApprovalCard }
  | { type: "approval.resolved"; interactionId: string; status: ResolvedStatus };

/** decide 的结构化结果：06 卡映射 allowed|denied|answered→200、not_found→404、already_resolved→409、invalid→400。 */
export type DecideOutcome =
  | { status: "allowed" | "denied" | "answered" }
  | { status: "already_resolved" }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

export interface ApprovalBridgeOptions {
  manager: InteractionManager;
  /** WS 层订阅审批事件；监听器异常只 warn，不得破坏状态机。 */
  onEvent?: (event: ApprovalEvent) => void;
}

const DECISION_FIELDS = { allow_once: ["applySuggestionIds"], deny: ["message"], answer: ["answers"] };

function parseDecision(raw: unknown): Decision {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InteractionTypeError("unknown decision type");
  }
  const body = raw as Record<string, unknown>;
  const type = Object.hasOwn(body, "decision") ? body.decision : body.type;
  if ((type !== "allow_once" && type !== "deny" && type !== "answer") ||
      (Object.hasOwn(body, "type") && body.type !== type)) {
    throw new InteractionTypeError("unknown or conflicting decision type");
  }
  const fields = ["type", "decision", ...DECISION_FIELDS[type]];
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw new InteractionTypeError("unexpected decision field");
  }
  if (type === "allow_once") {
    const ids = body.applySuggestionIds;
    if (!Object.hasOwn(body, "applySuggestionIds")) return { type };
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
      throw new InvalidPermissionSuggestionError("applySuggestionIds must be an array of strings");
    }
    return ids.length === 0 ? { type } : { type, applySuggestionIds: ids };
  }
  if (type === "deny") {
    if (!Object.hasOwn(body, "message")) return { type };
    if (typeof body.message !== "string") throw new InteractionTypeError("message must be a string");
    return { type, message: body.message };
  }
  const { answers } = body;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new InvalidInteractionAnswerError("answers must be an object");
  }
  const entries = Object.entries(answers);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new InvalidInteractionAnswerError("answers must contain string values");
  }
  return { type, answers: Object.fromEntries(entries) };
}

export class ApprovalBridge implements PermissionBroker {
  readonly #manager: InteractionManager;
  readonly #onEvent: ((event: ApprovalEvent) => void) | undefined;
  readonly #pending = new Map<string, { card: ApprovalCard; controller: AbortController; signal: AbortSignal }>();

  constructor(options: ApprovalBridgeOptions) {
    this.#manager = options.manager;
    this.#onEvent = options.onEvent;
  }

  /** SDK 审批入口（经 permission-adapter 调用）。fail-closed：异常一律 deny。 */
  async request(request: PermissionRequest, signal: AbortSignal): Promise<InteractionDecision> {
    try {
      if (signal.aborted) return { type: "deny", message: "Interaction cancelled" };
      const { sessionKey, userId, kind, requestId: _requestId, toolName, input, prompt, ...metadata } = request;
      if (kind === "approval") {
        const record = this.#manager.createApproval({
          sessionKey, userId, payload: { toolName, input, prompt, ...metadata },
        });
        return await this.#waitForDecision(record, signal);
      }

      const answers: Record<string, string> = {};
      for (const question of questionFromAskUserInput(input).questions) {
        const record = this.#manager.createQuestion({
          sessionKey, userId, payload: { questions: [question], ...metadata },
        });
        const decision = await this.#waitForDecision(record, signal);
        if (decision.type !== "answer") return { type: "deny", message: "Question was not answered" };
        Object.assign(answers, decision.answers);
      }
      return { type: "answer", answers };
    } catch (error) {
      return {
        type: "deny",
        message: `approval channel failed closed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** HTTP 决策入口（POST /api/interactions/:id/decision）。永不抛异常。 */
  decide(interactionId: string, raw: unknown): DecideOutcome {
    try {
      const decision = parseDecision(raw);
      const record = this.#manager.get(interactionId);
      if (record === undefined) return { status: "not_found" };
      const pending = this.#pending.get(interactionId);
      if (pending === undefined || pending.signal.aborted || record.status !== "pending") {
        return { status: "already_resolved" };
      }
      // 单用户系统：鉴权在 HTTP Bearer 层，这里用记录自身的 userId 决议。
      const resolution = this.#manager.resolve(interactionId, record.userId, decision);
      if (resolution.record.status !== "pending") this.#emitResolved(interactionId, resolution.record.status);
      const { status } = resolution.record;
      return status === "allowed" || status === "denied" || status === "answered"
        ? { status } : { status: "already_resolved" };
    } catch (error) {
      if (error instanceof InteractionAlreadyResolvedError) {
        this.cancelPending(interactionId);
        return { status: "already_resolved" };
      }
      if (error instanceof InteractionNotFoundError) return { status: "not_found" };
      if (error instanceof InteractionUnauthorizedError) return { status: "invalid", message: "unauthorized" };
      if (error instanceof InteractionTypeError || error instanceof InvalidInteractionAnswerError ||
          error instanceof InvalidPermissionSuggestionError) {
        return { status: "invalid", message: error.message };
      }
      this.cancelPending(interactionId);
      return { status: "invalid", message: "approval decision failed" };
    }
  }

  cancelPending(interactionId?: string): void {
    if (interactionId !== undefined) {
      this.#pending.get(interactionId)?.controller.abort();
      return;
    }
    for (const { controller } of this.#pending.values()) controller.abort();
  }

  /** 当前待决审批卡片，按创建先后。 */
  pending(): ApprovalCard[] {
    const now = Date.now();
    return [...this.#pending.values()].flatMap(({ card, signal }) =>
      !signal.aborted && card.expiresAt > now ? [card] : []);
  }

  async #waitForDecision(record: InteractionRecord, signal: AbortSignal): Promise<Decision> {
    const { interactionId } = record;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const waiting = this.#manager.awaitDecision(interactionId, combined);
      if (!combined.aborted) {
        const card = this.#card(record);
        this.#pending.set(interactionId, { card, controller, signal: combined });
        this.#emit({ type: "approval", interaction: card });
      }
      const decision = await waiting;
      if (this.#pending.has(interactionId)) {
        const status = this.#manager.get(interactionId)?.status;
        this.#emitResolved(interactionId, status === undefined || status === "pending" ? "denied" : status);
      }
      return combined.aborted ? { type: "deny", message: "Interaction cancelled" } : decision;
    } catch (error) {
      controller.abort();
      this.#emitResolved(interactionId, "denied");
      throw error;
    }
  }

  #card(record: InteractionRecord): ApprovalCard {
    const base = {
      interactionId: record.interactionId,
      sessionId: record.sessionKey,
      kind: record.kind,
      expiresAt: record.expiresAt,
    };
    if (record.kind === "approval") {
      return { ...base, ...record.payload as Approval };
    }
    const { questions, ...metadata } = record.payload as Question;
    return {
      ...base,
      ...metadata,
      toolName: "AskUserQuestion",
      input: { questions },
      prompt: questions[0]?.question ?? "AskUserQuestion",
      questions,
    };
  }

  #emitResolved(interactionId: string, status: ResolvedStatus): void {
    if (!this.#pending.delete(interactionId)) return;
    this.#emit({ type: "approval.resolved", interactionId, status });
  }

  #emit(event: ApprovalEvent): void {
    try {
      this.#onEvent?.(event);
    } catch (error) {
      console.warn("approval event listener failed:", error instanceof Error ? error.message : error);
    }
  }
}
