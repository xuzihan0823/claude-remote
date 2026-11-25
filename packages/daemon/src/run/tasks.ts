import { randomUUID } from "node:crypto";
import { TASK_OUTPUT_LIMIT, type TaskDetails, type TaskEvent, type TaskStatus } from "@claude-remote/agent-bridge";

type EndReason = "background_inactive" | "task_inactive" | "query_interrupted" | "run_ended" | "run_failed" | "run_aborted";
type EventIdentity = Pick<TaskEvent, "eventId" | "observedAt" | "timestamp">;
type Output = { output: string; outputTruncated: boolean };

export interface TaskSnapshot extends TaskDetails, EventIdentity {
  runId: string;
  revision: number;
  status: TaskStatus;
  background: boolean;
  firstObservedAt: number;
  startedAt?: number;
  endedAt?: number;
  endReason?: EndReason;
  stopRequested?: true;
  output?: string;
  outputTruncated?: boolean;
}

const MAX_SEEN_EVENTS = 4096;
const MAX_UNMATCHED_OUTPUTS = 64;

export class RunTasks {
  readonly #tasks = new Map<string, TaskSnapshot>();
  readonly #background = new Set<string>();
  readonly #seen = new Set<string>();
  readonly #byTool = new Map<string, string>();
  readonly #unmatchedOutputs = new Map<string, Output>();

  constructor(readonly runId: string, private readonly publish: (task: TaskSnapshot) => void) {}

  get(taskId: string): TaskSnapshot | undefined { return this.#tasks.get(taskId); }
  values(): IterableIterator<TaskSnapshot> { return this.#tasks.values(); }

  record(event: TaskEvent): void {
    if (this.#seen.has(event.eventId)) return;
    this.#seen.add(event.eventId);
    if (this.#seen.size > MAX_SEEN_EVENTS) this.#seen.delete(this.#seen.values().next().value!);

    const { eventId, observedAt, timestamp } = event;
    const identity = { eventId, observedAt, ...(timestamp === undefined ? {} : { timestamp }) };
    if (event.type === "task_output") {
      this.#recordOutput(event, identity);
    } else if (event.type === "background_tasks_changed") {
      const incoming = new Map(event.tasks.map((task) => [task.taskId, task]));
      for (const taskId of this.#background) {
        const task = this.get(taskId);
        if (task?.status === "running" && !incoming.has(taskId)) this.#end(task, "stopped", "background_inactive", identity);
      }
      this.#background.clear();
      for (const details of incoming.values()) {
        this.#background.add(details.taskId);
        this.#recordDetails(details, "running", "background", identity);
      }
    } else {
      const { type, status, eventId: _id, observedAt: _at, timestamp: _timestamp, ...details } = event;
      this.#recordDetails(details, status, type, identity);
    }
  }

  acceptStop(task: TaskSnapshot): TaskSnapshot {
    return this.#save({ ...task, stopRequested: true }, this.#localEvent());
  }

  inactive(task: TaskSnapshot): TaskSnapshot {
    return this.#end(task, "stopped", "task_inactive", this.#localEvent());
  }

  settle(reason: "query_interrupted" | "run_ended" | "run_failed" | "run_aborted"): void {
    for (const task of this.#tasks.values()) {
      if (task.status === "running") this.#end(task, reason === "run_failed" ? "failed" : "stopped", reason, this.#localEvent());
    }
    this.#background.clear();
    this.#byTool.clear();
    this.#unmatchedOutputs.clear();
  }

  #recordDetails(details: TaskDetails, status: TaskStatus, source: "background" | "task_started" | "task_progress" | "task_notification", identity: EventIdentity): void {
    const previous = this.get(details.taskId);
    const task: TaskSnapshot = previous ?? {
      runId: this.runId, taskId: details.taskId, status, background: false, revision: 0,
      firstObservedAt: identity.observedAt, ...identity,
    };
    if (task.endReason === "query_interrupted") return;
    const nativeEnd = source === "task_notification" && (!previous || task.status === "running" || task.endReason !== undefined);
    const level = source === "background";
    const revive = level && task.endReason === "background_inactive";
    const newerProgress = task.status === "running" && source === "task_progress" &&
      (!task.usage || (details.usage !== undefined && details.usage.durationMs >= task.usage.durationMs &&
        details.usage.totalTokens >= task.usage.totalTokens && details.usage.toolUses >= task.usage.toolUses));
    const { usage, summary, lastToolName, description, ...metadata } = details;
    const next = {
      ...metadata, ...task,
      ...(level ? { background: true } : {}),
      ...(description !== undefined && (task.description === undefined || newerProgress) ? { description } : {}),
      ...(usage !== undefined && (task.usage === undefined || nativeEnd || newerProgress) ? { usage } : {}),
      ...(summary !== undefined && (task.summary === undefined || nativeEnd || newerProgress) ? { summary } : {}),
      ...(lastToolName !== undefined && (task.lastToolName === undefined || newerProgress) ? { lastToolName } : {}),
    };
    if (source === "task_started" && next.startedAt === undefined) next.startedAt = identity.observedAt;
    if (next.toolUseId) {
      this.#byTool.set(next.toolUseId, next.taskId);
      const output = this.#unmatchedOutputs.get(next.toolUseId);
      if (output) {
        Object.assign(next, output);
        this.#unmatchedOutputs.delete(next.toolUseId);
      }
    }
    if (nativeEnd || revive) {
      next.status = status;
      delete next.endReason;
      delete next.stopRequested;
      if (nativeEnd) next.endedAt = identity.observedAt;
      else delete next.endedAt;
    }
    // A repeated level lists all live tasks. Publish only entries whose state or details changed.
    if (!previous || Object.keys(next).some((key) => next[key as keyof TaskSnapshot] !== previous[key as keyof TaskSnapshot])) {
      this.#save(next, identity);
    }
  }

  #recordOutput(event: Extract<TaskEvent, { type: "task_output" }>, identity: EventIdentity): void {
    const { toolUseId } = event;
    const taskId = this.#byTool.get(toolUseId);
    const task = taskId === undefined ? undefined : this.get(taskId);
    const previous = task ?? this.#unmatchedOutputs.get(toolUseId);
    if (previous?.outputTruncated) return;
    const combined = previous?.output ? `${previous.output}\n${event.output}` : event.output;
    const output = { output: combined.slice(0, TASK_OUTPUT_LIMIT), outputTruncated: event.outputTruncated || combined.length > TASK_OUTPUT_LIMIT };
    if (task) {
      this.#save({ ...task, ...output }, identity);
    } else {
      this.#unmatchedOutputs.set(toolUseId, output);
      if (this.#unmatchedOutputs.size > MAX_UNMATCHED_OUTPUTS) this.#unmatchedOutputs.delete(this.#unmatchedOutputs.keys().next().value!);
    }
  }

  #end(task: TaskSnapshot, status: Exclude<TaskStatus, "running">, endReason: EndReason, identity: EventIdentity): TaskSnapshot {
    const next = { ...task, status, endReason, endedAt: identity.observedAt };
    delete next.stopRequested;
    return this.#save(next, identity);
  }

  #save(task: TaskSnapshot, identity: EventIdentity): TaskSnapshot {
    const next = { ...task, ...identity, revision: task.revision + 1 };
    if (identity.timestamp === undefined) delete next.timestamp;
    this.#tasks.set(next.taskId, next);
    this.publish(next);
    return next;
  }

  #localEvent(): EventIdentity { return { eventId: randomUUID(), observedAt: Date.now() }; }
}
