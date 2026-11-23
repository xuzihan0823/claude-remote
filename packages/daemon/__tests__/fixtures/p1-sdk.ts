import assert from "node:assert/strict";
import type { QueryFactory } from "@claude-remote/agent-bridge";

type Query = ReturnType<QueryFactory>;
type Message = Query extends AsyncIterable<infer Item> ? Item : never;
type Params = Parameters<QueryFactory>[0];

export class P1Query {
  readonly #output = new Array<Message>();
  #waiter: ((item: IteratorResult<Message>) => void) | undefined;
  readonly #input: AsyncIterator<unknown>;
  closed = false;
  interrupts = 0;
  onInterrupt?: () => Promise<void> | void;
  onReturn?: () => Promise<void>;
  mcpStatuses: Array<Record<string, unknown>> = [];
  contextCalls = 0;
  contextFailable = false;
  commands = [
    { name: "compact", description: "Summarize conversation", argumentHint: "[focus]" },
    { name: "context", description: "Show context", argumentHint: "" },
    { name: "review", description: "Review source", argumentHint: "<path>", aliases: ["rv"] },
    { name: "color", description: "Terminal colors", argumentHint: "" },
    { name: "other", description: "Not confirmed by SDK init", argumentHint: "" },
  ];
  skills = ["review", "hidden"];

  constructor(readonly params: Params) {
    assert.notEqual(typeof params.prompt, "string");
    if (typeof params.prompt === "string") throw new Error("stream expected");
    this.#input = params.prompt[Symbol.asyncIterator]();
  }

  async input(): Promise<{ uuid: string; message: { content: string } }> {
    const item = await this.#input.next();
    assert.equal(item.done, false);
    return item.value as { uuid: string; message: { content: string } };
  }

  send(value: Record<string, unknown>): void {
    if (this.closed) return;
    const message = { session_id: this.params.options?.resume ?? this.params.options?.sessionId, ...value } as unknown as Message;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter) waiter({ value: message, done: false });
    else this.#output.push(message);
  }

  init(apiKeySource = "oauth"): void {
    this.send({ type: "system", subtype: "init", uuid: "init", permissionMode: "default", apiKeySource, claude_code_version: "2.1.330",
      slash_commands: ["compact", "review", "interactive"], terminal_slash_commands: ["interactive"], skills: ["review"] });
  }

  result(id: string, options: { uuid?: string; tokens?: number; total?: number; error?: string; result?: string } = {}): void {
    const { uuid = "result-" + id, tokens = 3, total = 0.04, error, result = "" } = options;
    this.send({
      type: "result", subtype: error ? "error_during_execution" : "success", uuid, is_error: Boolean(error),
      ...(error ? { errors: [error] } : { result }),
      user_message_uuids: [id], total_cost_usd: total,
      usage: { input_tokens: tokens, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 },
      modelUsage: { fixture: { inputTokens: total === 0.04 ? 3 : 9 } },
      model_usage_since_last_result: { fixture: { inputTokens: tokens } },
    });
  }

  close(): void {
    this.closed = true;
    this.#output.length = 0;
    this.#waiter?.({ value: undefined, done: true });
    this.#waiter = undefined;
  }

  get query(): Query {
    return {
      close: () => this.close(),
      interrupt: async () => {
        this.interrupts += 1;
        if (this.onInterrupt) await this.onInterrupt();
        else this.close();
      },
      return: async () => {
        this.close();
        await this.onReturn?.();
        return { value: undefined, done: true };
      },
      mcpServerStatus: async () => this.mcpStatuses,
      supportedCommands: async () => this.commands,
      reloadSkills: async () => ({ skills: this.skills.map((name) => ({ name, description: "", argumentHint: "" })) }),
      getContextUsage: async () => {
        this.contextCalls += 1;
        if (this.contextFailable) throw new Error("unsupported control");
        return { model: "fixture", totalTokens: 50, maxTokens: 100, percentage: 50,
          categories: [{ name: "Messages", tokens: 50, color: "text" }], gridRows: [] };
      },
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const item = this.#output.shift();
          if (item) return { value: item, done: false };
          if (this.closed) return { value: undefined, done: true };
          return new Promise<IteratorResult<Message>>((resolve) => { this.#waiter = resolve; });
        },
        return: async () => {
          this.close();
          return { value: undefined, done: true };
        },
      }),
    } as unknown as Query;
  }
}

export function fakeP1Sdk(): { factory: QueryFactory; queries: P1Query[] } {
  const queries: P1Query[] = [];
  const factory: QueryFactory = (params) => {
    const query = new P1Query(params);
    queries.push(query);
    return query.query;
  };
  return { factory, queries };
}
