import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptSdkMessage } from "@claude-remote/agent-bridge";
import { InteractionManager, InteractionStore } from "@claude-remote/interactions";

test("daemon skeleton wires workspace packages", () => {
  const store = new InteractionStore();
  const manager = new InteractionManager(store, { autoScheduleExpiry: false });
  try {
    assert.equal(typeof adaptSdkMessage, "function");
    assert.equal(manager.store, store);
  } finally {
    manager.close();
    store.close();
  }
});
