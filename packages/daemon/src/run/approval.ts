// PermissionBroker → interactions 状态机 → WS 审批卡片的桥。
//
// 两侧的失败纪律不同：SDK 侧（request）fail-closed——任何异常一律折算成 deny；
// HTTP 侧（decide）永不抛裸异常——已解决/不存在/类型不匹配全部转成结构化结果
// （旧项目审查教训：双击按钮不得 500）。
//
// 超时 auto-deny 与重启 auto-deny 由 interactions 包既有逻辑负责；本模块只在
// awaitDecision 返回后按落库状态补发 approval.resolved（含 expired）。

import { isElicitationContent, type ElicitationBroker, type InteractionDecision, type PermissionBroker, type PermissionMetadata, type PermissionRequest } from "@claude-remote/agent-bridge";
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
  type Elicitation,
  type ElicitationDecision,
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

type ElicitationCard = Elicitation & {
  interactionId: string;
  sessionId: string;
  runId: string;
  kind: "elicitation";
  expiresAt: number;
};

export type ApprovalEvent =
  | { type: "approval"; interaction: ApprovalCard }
  | { type: "approval.resolved"; interactionId: string; status: ResolvedStatus }
  | { type: "elicitation"; interaction: ElicitationCard }
  | { type: "elicitation.resolved"; sessionId: string; runId: string; interactionId: string; status: ResolvedStatus; action: ElicitationDecision["action"] };

/** decide 的结构化结果：06 卡映射 allowed|denied|answered→200、not_found→404、already_resolved→409、invalid→400。 */
export type DecideOutcome =
  | { status: "allowed" | "denied" | "answered" }
  | { status: "allowed" | "denied"; action: ElicitationDecision["action"] }
  | { status: "already_resolved" }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

export interface ApprovalBridgeOptions {
  manager: InteractionManager;
  /** 返回 true 表示已把 elicitation 交付给订阅者。 */
  onEvent?: (event: ApprovalEvent) => boolean | void;
}

const DECISION_FIELDS = { allow_once: ["applySuggestionIds"], deny: ["message"], answer: ["answers"], elicitation: ["action", "content"] };

function parseDecision(raw: unknown): Decision {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InteractionTypeError("unknown decision type");
  }
  const body = raw as Record<string, unknown>;
  const type = Object.hasOwn(body, "decision") ? body.decision : body.type;
  if ((type !== "allow_once" && type !== "deny" && type !== "answer" && type !== "elicitation") ||
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
  if (type === "elicitation") {
    const { action, content } = body;
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw new InteractionTypeError("invalid elicitation action");
    }
    if (content === undefined) return { type, action };
    if (action === "accept" && isElicitationContent(content)) return { type, action, content };
    throw new InteractionTypeError("invalid elicitation content");
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

export class ApprovalBridge implements PermissionBroker, ElicitationBroker {
  readonly #manager: InteractionManager;
  readonly #pending = new Map<string, { card: ApprovalCard; controller: AbortController; signal: AbortSignal }>();
  readonly #onEvent: ApprovalBridgeOptions["onEvent"];
  readonly #elicitations = new Map<string, { card: ElicitationCard; controller: AbortController; signal: AbortSignal }>();

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

  async requestElicitation(
    request: Parameters<ElicitationBroker["requestElicitation"]>[0], signal: AbortSignal,
  ): ReturnType<ElicitationBroker["requestElicitation"]> {
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    let interactionId: string | undefined;
    let status: ResolvedStatus = "denied";
    let decision: ElicitationDecision = { type: "elicitation", action: "cancel" };
    try {
      if (lifetime.aborted || !this.#onEvent) return { action: "cancel" };
      const { sessionKey, runId, userId, payload } = request;
      const record = this.#manager.createElicitation({ sessionKey, userId, payload });
      interactionId = record.interactionId;
      const card: ElicitationCard = { ...payload, interactionId, sessionId: sessionKey, runId, kind: "elicitation", expiresAt: record.expiresAt };
      const waiting = this.#manager.awaitDecision(interactionId, lifetime);
      this.#elicitations.set(interactionId, { card, controller, signal: lifetime });
      try {
        if (this.#onEvent({ type: "elicitation", interaction: card }) !== true) controller.abort();
      } catch {
        controller.abort();
      }
      const result = await waiting;
      const settled = this.#manager.get(interactionId);
      if (settled?.status === "expired") status = "expired";
      if (!lifetime.aborted && settled?.status !== "pending" && settled?.decision?.type === "elicitation" && result.type === "elicitation") {
        status = settled.status;
        decision = result;
      }
      return decision.action === "accept" && decision.content !== undefined
        ? { action: "accept", content: decision.content } : { action: decision.action };
    } catch {
      controller.abort();
      return { action: "cancel" };
    } finally {
      if (interactionId !== undefined) {
        this.#elicitations.delete(interactionId);
        this.#emit({ type: "elicitation.resolved", sessionId: request.sessionKey, runId: request.runId,
          interactionId, status, action: decision.action });
      }
    }
  }

  cancelElicitation(interactionId: string): void {
    this.#elicitations.get(interactionId)?.controller.abort();
  }

  cancelElicitations(sessionId: string): void {
    for (const { card, controller } of this.#elicitations.values()) {
      if (card.sessionId === sessionId) controller.abort();
    }
  }

  /** HTTP 决策入口（POST /api/interactions/:id/decision）。永不抛异常。 */
  decide(interactionId: string, raw: unknown): DecideOutcome {
    try {
      const decision = parseDecision(raw);
      const record = this.#manager.get(interactionId);
      if (record === undefined) return { status: "not_found" };
      const pending = record.kind === "elicitation" ? this.#elicitations.get(interactionId) : this.#pending.get(interactionId);
      if (pending === undefined || pending.signal.aborted || record.status !== "pending") {
        return { status: "already_resolved" };
      }
      // 单用户系统：鉴权在 HTTP Bearer 层，这里用记录自身的 userId 决议。
      const resolution = this.#manager.resolve(interactionId, record.userId, decision);
      const { status } = resolution.record;
      if (resolution.decision.type === "elicitation") {
        return status === "allowed" || status === "denied"
          ? { status, action: resolution.decision.action } : { status: "already_resolved" };
      }
      if (status !== "pending") this.#emitResolved(interactionId, status);
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
      const wasElicitation = this.#elicitations.has(interactionId);
      this.cancelPending(interactionId);
      return { status: "invalid", message: wasElicitation ? "elicitation decision unavailable" : "approval decision failed" };
    }
  }

  cancelPending(interactionId?: string): void {
    if (interactionId !== undefined) {
      this.#pending.get(interactionId)?.controller.abort();
      this.cancelElicitation(interactionId);
      return;
    }
    for (const { controller } of this.#pending.values()) controller.abort();
    for (const { controller } of this.#elicitations.values()) controller.abort();
  }

  /** 当前待决审批卡片，按创建先后。 */
  pending(): ApprovalCard[] {
    const now = Date.now();
    return [...this.#pending.values()].flatMap(({ card, signal }) =>
      !signal.aborted && card.expiresAt > now ? [card] : []);
  }

  async #waitForDecision(record: InteractionRecord<Approval | Question>, signal: AbortSignal): Promise<InteractionDecision> {
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
      return combined.aborted || decision.type === "elicitation" ? { type: "deny", message: "Interaction cancelled" } : decision;
    } catch (error) {
      controller.abort();
      this.#emitResolved(interactionId, "denied");
      throw error;
    }
  }

  #card(record: InteractionRecord<Approval | Question>): ApprovalCard {
    const base = {
      interactionId: record.interactionId,
      sessionId: record.sessionKey,
      kind: record.kind === "approval" ? "approval" as const : "question" as const,
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
