# Chat reliability, streaming, and bubble direction (2026-10-19)

## Observed symptoms

- Mobile reply latency: nothing appears until the turn's JSONL rows are written and the watcher pushes them. The daemon receives real SDK partial messages but never forwards them.
- Duplicate user bubble: the official right-aligned row appears next to a left-aligned "发送中…" header row for the same message.
- Desktop Code sidebar does not list the phone-started session.

## Confirmed code evidence

- `packages/daemon/src/server.ts` `#pumpRun` (~508): every `worker` event except `session` is dropped; `assistant_delta` never reaches clients. Only watcher `message` frames reach the UI.
- `packages/agent-bridge/src/event-adapter.ts:28-37`: `assistant_delta` only handles `text_delta` and uses `stream_event.uuid`, which is not a stable message identity (`SDKPartialAssistantMessage.uuid` differs per stream event wrapper; `SDKAssistantMessage.message.id` may be shared by multiple wrappers).
- `app/src/components/composer/ChatComposer.js` `doSend` (~59-100): awaits uploads + POST, then calls `onSent?.(text)`. A WS echo or run terminal event can arrive before the POST resolves; the later `onSent` re-creates the pending bubble.
- `app/src/screens/ChatScreen.js`: pending is a `ListHeader` item (left avatar, "发送中…"), separate from the real row; `addMsgs` never reconciles it; `ws:resync` does not clear it; `ws-open` returns early when the store is empty.
- `app/src/screens/ChatScreen.js:118-134`: any terminal `run` frame clears `runActive`/`activeRunId`/pending without checking `runId`, so a late terminal from an old run can corrupt a new turn.
- `packages/daemon/src/server.ts` abort route (~415-427): ignores the client's runId and aborts the session's current run, so a late stop kills the next turn.
- `web/core/ws.js`: no application-level liveness; daemon protocol ping is invisible to JS. `subscribe` resolves only when the server has added the watcher; there is no ready ack. `packages/daemon/src/watch/watcher.ts` uses `#pendingWatch` and returns early on concurrent watch, so "subscribed" cannot be inferred.
- `packages/daemon/src/transcript/reader.ts`: `parseTranscriptLine` reads `message.content` but does not project `message.id`, so a streamed block cannot be matched to its persisted row.
- `SDKUserMessage.uuid?: UUID` exists in the bundled SDK (`@anthropic-ai/claude-agent-sdk` 0.3.212 types, ~4463-4505) and the current `startSdkQuery` does not set it.

## Desktop session visibility

Official docs (`https://code.claude.com/docs/en/desktop.md`, "Coming from the CLI?"): CLI and Desktop keep independent session lists; Desktop's `/resume` can pick a CLI session and continue the same session. The phone-started session (`19d18014-f33e-479b-b44f-857243e8ada1`, cwd `/Users/mac`) therefore has to be selected there. No registry/DB edits are made.

## Design decisions

- Add client-generated `clientMessageId` and thread it to the SDK input `uuid`; expose it in the 202 response and reconcile against `RenderMessage.uuid`.
- Send state machine: sending → accepted → confirmed; definite rejection is `failed`, ambiguous timeout/5xx is `unconfirmed` (history reconciliation only, no auto-resend).
- Application-level ping/pong with foreground watchdog; subscribe ack after a genuinely ready watcher (shared init promise); unify initial load, ws-open, and resync through one snapshot reconciliation.
- Real streaming: StreamTracker keyed by `(api message id, block index)`, bounded per-run accumulation, WS `stream`/`stream_snapshot` frames, and exact replacement once the JSONL row with the same `apiMessageId` arrives.
- UI: all user states right-aligned in the standard bubble; assistant stays left; short native-driver entrance animation for newly inserted user rows only; ReduceMotion disables transform.

## Verification constraints

- No paid model requests. Use fake SDK / mock WS server plus an isolated CLI check for UUID persistence only if it can be run against a local fake API.
- Native behavior must be checked in the iOS simulator, not browser preview.
