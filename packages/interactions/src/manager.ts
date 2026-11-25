import { randomBytes } from "node:crypto";

import { InteractionStore } from "./store.js";
import { failClosedDecision } from "./types.js";
import type {
  Approval,
  CreateInteractionInput,
  Decision,
  Elicitation,
  InteractionKind,
  InteractionPayload,
  InteractionRecord,
  Question,
  Resolution,
} from "./types.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export class InteractionNotFoundError extends Error {}
export class InteractionUnauthorizedError extends Error {}
export class InteractionAlreadyResolvedError extends Error {}
export class InteractionTypeError extends Error {}
export class InvalidInteractionAnswerError extends Error {}
export class InvalidPermissionSuggestionError extends Error {}

interface Waiter {
  resolve: (decision: Decision) => void;
  cleanup: () => void;
  kind: InteractionKind;
}

export interface InteractionManagerOptions {
  defaultTtlMs?: number;
  now?: () => number;
  autoScheduleExpiry?: boolean;
  cleanPendingOnStart?: boolean;
}

function createInteractionId(): string {
  return randomBytes(18).toString("base64url");
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive safe integer");
  }
}

function assertQuestion(question: Question): void {
  if (question.questions.length < 1 || question.questions.length > 4) {
    throw new RangeError("AskUserQuestion requires between 1 and 4 questions");
  }
  for (const item of question.questions) {
    if (!item.question.trim() || !item.header.trim()) {
      throw new TypeError("question text and header cannot be empty");
    }
    if (item.options.length < 2 || item.options.length > 4) {
      throw new RangeError("each question requires between 2 and 4 options");
    }
  }
}

function decisionStatus(decision: Decision): "allowed" | "denied" | "answered" {
  switch (decision.type) {
    case "allow_once":
      return "allowed";
    case "deny":
      return "denied";
    case "answer":
      return "answered";
    case "elicitation":
      return decision.action === "accept" ? "allowed" : "denied";
  }
}

export class InteractionManager {
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #defaultTtlMs: number;
  readonly #now: () => number;
  readonly #autoScheduleExpiry: boolean;

  constructor(readonly store: InteractionStore, options: InteractionManagerOptions = {}) {
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    assertPositiveTtl(this.#defaultTtlMs);
    this.#now = options.now ?? Date.now;
    this.#autoScheduleExpiry = options.autoScheduleExpiry ?? true;

    if (options.cleanPendingOnStart ?? true) {
      store.denyPendingOnRestart(this.#now());
    }
  }

  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const [id, waiters] of this.#waiters) {
      const waiter = waiters.values().next().value;
      if (waiter) this.#finish(id, failClosedDecision(waiter.kind, "Interaction manager closed"));
    }
  }

  createApproval(input: CreateInteractionInput<Approval>): InteractionRecord<Approval> {
    return this.#create("approval", input);
  }

  createQuestion(input: CreateInteractionInput<Question>): InteractionRecord<Question> {
    assertQuestion(input.payload);
    return this.#create("question", input);
  }

  createElicitation(input: CreateInteractionInput<Elicitation>): InteractionRecord<Elicitation> {
    return this.#create("elicitation", input);
  }

  get(interactionId: string): InteractionRecord | undefined {
    return this.store.get(interactionId);
  }

  awaitDecision(interactionId: string, signal?: AbortSignal): Promise<Decision> {
    const record = this.store.get(interactionId);
    if (record === undefined) return Promise.reject(new InteractionNotFoundError("interaction not found"));
    if (record.decision !== null) return Promise.resolve(record.decision);

    return new Promise<Decision>((resolve) => {
      const waiter: Waiter = { resolve, kind: record.kind, cleanup: () => signal?.removeEventListener("abort", abort) };
      const waiters = this.#waiters.get(interactionId) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.#waiters.set(interactionId, waiters);

      const abort = (): void => {
        signal?.removeEventListener("abort", abort);
        const decision = failClosedDecision(record.kind, "Interaction cancelled");
        try {
          this.store.resolve({ interactionId, userId: record.userId, status: "denied", decision,
            resolvedAt: this.#now(), auditAction: "auto_deny_cancelled" });
        } catch (error) {
          console.warn("interaction cancellation failed:", error);
        } finally {
          this.#finish(interactionId, decision);
        }
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  resolve(interactionId: string, userId: string, decision: Decision): Resolution {
    const current = this.#getPendingForUser(interactionId, userId);
    this.#assertDecisionMatches(current, decision);

    const resolvedAt = this.#now();
    const record = this.store.resolve({
      interactionId,
      userId,
      status: decisionStatus(decision),
      decision: decision.type === "elicitation" ? { type: "elicitation", action: decision.action } : decision,
      resolvedAt,
      auditAction: decision.type,
    }, this.#now);
    if (record?.decision == null) {
      throw new InteractionAlreadyResolvedError("interaction was already resolved");
    }

    // Elicitation content may be sensitive. Deliver it to live waiters only.
    const applied = record.status !== "expired" && decision.type === "elicitation" ? decision : record.decision;
    this.#finish(interactionId, applied);
    return { record, decision: applied };
  }

  expireDue(now = this.#now()): InteractionRecord[] {
    const expired = this.store.expirePending(now);
    for (const record of expired) {
      if (record.decision !== null) this.#finish(record.interactionId, record.decision);
    }
    return expired;
  }

  #create<T extends InteractionPayload>(
    kind: InteractionKind,
    input: CreateInteractionInput<T>,
  ): InteractionRecord<T> {
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    assertPositiveTtl(ttlMs);
    const createdAt = this.#now();
    const record: InteractionRecord<T> = {
      interactionId: createInteractionId(),
      sessionKey: input.sessionKey,
      userId: input.userId,
      kind,
      payload: input.payload,
      status: "pending",
      expiresAt: createdAt + ttlMs,
      resolvedAt: null,
      decision: null,
      createdAt,
    };
    this.store.create(record);
    if (this.#autoScheduleExpiry) this.#scheduleExpiry(record);
    return record;
  }

  #scheduleExpiry(record: InteractionRecord): void {
    const delay = Math.min(2_147_483_647, Math.max(0, record.expiresAt - this.#now()));
    const timer = setTimeout(() => {
      const now = this.#now();
      if (now < record.expiresAt) {
        this.#scheduleExpiry(record);
        return;
      }
      const decision = failClosedDecision(record.kind, "Interaction timed out");
      try {
        this.store.resolve({
          interactionId: record.interactionId, userId: record.userId, status: "expired",
          decision, resolvedAt: now, auditAction: "auto_deny_timeout",
        });
      } catch (error) {
        console.warn("interaction expiry failed:", error);
      } finally {
        this.#finish(record.interactionId, decision);
      }
    }, delay);
    timer.unref();
    this.#timers.set(record.interactionId, timer);
  }

  #getPendingForUser(interactionId: string, userId: string): InteractionRecord {
    const record = this.store.get(interactionId);
    if (record === undefined) throw new InteractionNotFoundError("interaction not found");
    if (record.userId !== userId) {
      this.store.appendAudit(interactionId, "unauthorized_resolution", userId, null, this.#now());
      throw new InteractionUnauthorizedError("interaction belongs to a different QQ user");
    }
    if (record.status !== "pending") {
      throw new InteractionAlreadyResolvedError("interaction was already resolved");
    }
    return record;
  }

  #assertDecisionMatches(record: InteractionRecord, decision: Decision): void {
    if ((record.kind === "elicitation") !== (decision.type === "elicitation")) {
      throw new InteractionTypeError("elicitation requires an elicitation decision");
    }
    if (record.kind === "elicitation" && decision.type === "elicitation" && decision.action === "accept" && decision.content !== undefined && (record.payload as Elicitation).mode !== "form") {
      throw new InteractionTypeError("URL elicitation does not accept form content");
    }
    if (record.kind === "approval" && decision.type === "answer") {
      throw new InteractionTypeError("approval cannot be resolved with an answer");
    }
    if (record.kind === "question" && decision.type !== "answer") {
      throw new InteractionTypeError("question must be resolved with answers");
    }
    if (record.kind === "approval" && decision.type === "allow_once" && decision.applySuggestionIds !== undefined) {
      const ids = decision.applySuggestionIds;
      const allowed = new Set((record.payload as Approval).suggestions?.map(({ id }) => id));
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) {
        throw new InvalidPermissionSuggestionError("applySuggestionIds must contain unique IDs from this approval");
      }
    }
    if (record.kind === "question" && decision.type === "answer") {
      const question = record.payload as Question;
      for (const item of question.questions) {
        const answer = decision.answers[item.question]?.trim();
        if (!answer) throw new InvalidInteractionAnswerError(`missing answer for: ${item.question}`);
      }
    }
  }

  #finish(interactionId: string, decision: Decision): void {
    const timer = this.#timers.get(interactionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(interactionId);

    const waiters = this.#waiters.get(interactionId);
    this.#waiters.delete(interactionId);
    for (const waiter of waiters ?? []) {
      waiter.cleanup();
      waiter.resolve(decision);
    }
  }
}
