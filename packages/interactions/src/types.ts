import type { InteractionDecision, PermissionMetadata } from "@claude-remote/agent-bridge";

export type InteractionKind = "approval" | "question";
export type InteractionStatus = "pending" | "allowed" | "denied" | "answered" | "expired";

export interface Approval extends PermissionMetadata {
  toolName: string;
  input: Record<string, unknown>;
  prompt: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface Question extends PermissionMetadata {
  questions: QuestionItem[];
}

export type InteractionPayload = Approval | Question;

export type Decision = InteractionDecision;

export interface InteractionRecord<T extends InteractionPayload = InteractionPayload> {
  interactionId: string;
  sessionKey: string;
  userId: string;
  kind: InteractionKind;
  payload: T;
  status: InteractionStatus;
  expiresAt: number;
  resolvedAt: number | null;
  decision: Decision | null;
  createdAt: number;
}

export interface AuditRecord {
  auditId: number;
  interactionId: string;
  action: string;
  actorUserId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

export interface CreateInteractionInput<T extends InteractionPayload> {
  sessionKey: string;
  userId: string;
  payload: T;
  ttlMs?: number;
}

export interface Resolution {
  record: InteractionRecord;
  decision: Decision;
}
