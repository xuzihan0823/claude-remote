# Technical Design

## Boundaries And Data Flow

```text
Mac ~/.claude/settings.json + Claude Agent SDK
        ↓ model catalog/default projection
daemon HTTP/WS contract
        ↓ authenticated JSON + run/message frames
Web/PWA + Capacitor iOS shell
        ↓ model/cwd/text/abort actions
daemon TurnRunner → SDK query → ~/.claude/projects/<cwd>/<sessionId>.jsonl
        ↓ SessionWatcher
Web/PWA transcript and status state
```

The daemon owns validation and normalization. The frontend consumes typed
projections and must not parse settings JSON or transcript records itself.

## Backend And SDK

- The model-config reader consumes `modelPicker.options` from the selected Mac
  settings file. Valid trimmed `model` values become both `id` and `alias` for
  existing client compatibility. A trimmed non-empty `label` becomes
  `displayName`, otherwise use the existing ID-derived name. Preserve first
  occurrence order, deduplicate by full ID, and project only those three fields.
- If valid picker options exist, show those options rather than appending the
  four legacy alias rows. Resolve the default through its configured alias
  mapping when applicable, and include a valid default absent from the picker.
  Keep built-in aliases accepted by the shared model validation helper.
- If no valid picker options exist, preserve the legacy four-alias catalog and
  optional default. Missing/malformed settings must not prevent startup. Re-read
  settings on catalog requests; do not mutate Mac settings or client UI.
- Extend `StartQueryOptions` and `startSdkQuery` with optional `model` and
  `sessionId`; pass them to the SDK only when present. Keep `resume` and
  `sessionId` mutually exclusive for new sessions.
- Extend `StartTurnOptions` with the optional model and a new-session mode, or
  use one internal start path that accepts a generated explicit session ID and
  omits `resume` for new sessions.
- Keep `ActivityTracker` keyed by the explicit session ID. The new session must
  be watched once its transcript file exists; the first `session`/message event
  is the handoff point if the file is not present at request time.
- Add an active-run lookup by session and an authenticated abort route. The
  existing close path and run event pump remain the single lifecycle owner.

## API Contract

- `GET /api/models` → `{ models: ModelOption[], defaultModel?: string }`.
- `POST /api/sessions` body `{ cwd: string, text: string, model?: string }` →
  `202 { sessionId, runId }`.
- `POST /api/sessions/:id/abort` → `200 { runId, status: "aborted" }`; unknown
  or finished run is a safe structured response, not an exception.
- Existing `POST /api/sessions/:id/messages` accepts optional `model` for a
  per-turn override and remains backward compatible.
- WS run/message/status semantics remain unchanged; new-session clients
  subscribe by the returned session ID.

All API inputs are validated at the HTTP boundary. Errors use the existing
`{ error: string, ... }` shape and status mapping.

## Frontend And iOS

- Keep hash routing and Preact state. Add a new-chat state/view without
  introducing a bundler or new runtime dependency.
- Reuse the existing composer component by making it accept a target mode:
  existing session vs. new session. Model and cwd selectors are local UI state;
  server data is refreshed on connection/reconnect.
- Add a stop button with an accessible label and a disabled/loading state. Do
  not expose a text explanation of keyboard shortcuts in the UI.
- Replace the inline `Spark` path with a shared twelve-ray polygon/path. Keep
  `web/icons/*` and the synced `ios/App/App/public` assets consistent, then
  regenerate the iOS app icon without alpha.

## Native Project Conversations (2026-10-18)

`GET /api/projects` returns `{ projects: [{ id, name, cwd, cwds, sessionCount, lastActiveAt }], totalSessions, unclassifiedCount }`. IDs are full repository-root paths for Git workspaces (resolve the common Git directory using bounded, argument-based Git execution); otherwise the original full cwd. Only cwd values present in indexed transcripts are exposed as runnable `cwds`; `cwd` is the most recently active known workspace, not necessarily the repository root.

`GET /api/sessions` accepts optional `projectId` and `cwd`, with empty `projectId` selecting missing-cwd sessions. Project filtering uses the same projection as the catalog and runs before offset/limit; unknown IDs return an empty page. Existing requests and response fields remain compatible. `POST /api/sessions` continues receiving the original known cwd.

The native app owns a project context shared by drawer and Home. Drawer selection is a browsing filter; Home target is an explicit cwd. Selecting a project updates its default target, while opening/new-from a conversation supplies its real cwd. ProjectPicker reuses the existing bottom-sheet interaction, with workspace choices for grouped worktrees. The catalog refreshes on reconnect/foreground and session activity; async results are guarded against stale connection/filter responses. Paginated lists deduplicate by sessionId. Local preferences are scoped by the normalized daemon base URL; token changes reset in-memory state. Tokens are only part of the in-memory mount identity, never persisted in preference keys.

## Expandable Native Sidebar (2026-10-18)

Use one virtualized list of project-header, conversation, and group-footer rows. Project headers come from the complete catalog, not loaded conversation pages. A pure group controller owns independent `createSessionPager` instances and an expanded-ID set; a thin React hook connects catalog, refresh signals, optimistic rows, cached current-session metadata, and live status. First expansion fetches one project; collapse caches rows; refresh invalidates all caches but only fetches expanded groups. Each group has its own explicit older-page/retry action. Disposal prevents late publishes, and catalog removal disposes obsolete entries.

Expansion is independent of the legacy browsing filter and Home target. Current-session navigation/cache metadata determines initial expansion without treating missing cache as missing cwd; manual collapse survives catalog polling. Project new-chat actions reuse Home's `fromCwd`/`nonce` route protocol with the catalog's actual `cwd`, never the group ID. Multi-workspace rows preserve workspace context. Existing brand, theme, safe-area and bottom actions remain unchanged.

## Home-Directory Default (2026-10-18)

`GET /api/projects` gains `homeCwd`, the daemon host's `os.homedir()`. It is not a project and has no transcript-derived group until a session exists there. New-session validation accepts `homeCwd` in addition to transcript-known cwds; repository-root IDs remain rejected. On the Mac this is `/Users/mac`, producing the normal `-Users-mac` transcript directory.

Home defaults to `homeCwd` only when the persisted target is `null` and no project preference supplies a target. Explicit, inherited, and intentionally empty targets are unchanged. A missing catalog still leaves send disabled. The target picker lists the home option first and labels it `主目录 (~)`, excluding the duplicate catalog project once home sessions exist. Creating a home session requires no daemon configuration change; restarting the daemon is required to serve `homeCwd`.

## Chat Reliability, Streaming, And Bubble Direction (2026-10-19)

**Identity.** `POST /api/sessions/:id/messages` accepts an optional `clientMessageId` UUID, validated at the HTTP boundary, returned in the `202` body together with `runId`. `TurnRunner.startTurn` forwards it to `startSdkQuery`, which sets it as the SDK `userMessage()` `uuid`. Because the CLI persists the input UUID, the confirmation key is `RenderMessage.uuid === clientMessageId`. Clients without it fall back to matching the earliest unconfirmed user text. New-session creation accepts an optional client-provided `sessionId` (strict UUID, conflict rejected) so a lost `202` is still recoverable by targeted query.

**Send states.** Client-side: `sending` → `accepted` → `confirmed`. Definite rejection (4xx, `not_idle`) becomes `failed` with the text recoverable; ambiguous timeout/5xx becomes `unconfirmed`, which only reconciles from history and is never retried automatically. Incoming WS confirmations win over late HTTP outcomes. A synchronous ref lock prevents double submit, and the send snapshot is frozen before the draft is cleared.

**Liveness and reconciliation.** WS gains `{"type":"ping"}` → `{"type":"pong"}`, routed before session validation. Foreground clients ping every 10 s and treat 5 s without pong as a half-open socket; background pauses the watchdog; foreground reconnect resyncs. A daemon that never answers pong degrades to data-frame liveness. `subscribe` acknowledges with `{"type":"subscribed","sessionId"}` only after the watcher initialization Promise resolves; concurrent initialization shares one Promise. `GET /api/sessions/:id/messages` additionally returns `status` and `activeRunId`. All entry points (first load, `ws-open`, `resync`) use one reconciliation: live frames are buffered until the subscribe ack, then the snapshot replaces the contiguous tail window (bounded multi-page lookback rather than a fixed three-page splice); an empty store still resyncs; a reader parked in older history keeps its viewport and gets a "back to latest" affordance. Connection/session/sync generation and runId guards drop stale results. Abort accepts an optional `runId` and only aborts when it matches the active run.

**Streaming.** `event-adapter` accepts an optional `StreamTracker` that follows `message_start.message.id`, `content_block_start.index`, and `content_block_delta.text`, so deltas carry a stable `(apiMessageId, blockIndex)` rather than the stream-event UUID. The default pure-function behavior and existing tests remain unchanged. The runner keeps a bounded per-run stream buffer (latest text per block, ~32 KB total). `#pumpRun` broadcasts `{"type":"stream","sessionId","runId","messageId","blockIndex","text"}`; a (re)subscribe to a session with an active run first receives `{"type":"stream_snapshot",...}`. `parseTranscriptLine` projects an optional `apiMessageId` from `message.id` (read-only). Clients keep transient items keyed by `(runId, apiMessageId, blockIndex)` and replace them in the same render batch when the persisted row arrives; resync and run end clear leftovers. Tool calls, thinking, and `parent_tool_use_id` subagent output stay out of the main chat stream.

**UI.** The left-aligned pending header is removed. Sending user messages become ordinary rows sharing the existing right-aligned bubble; a reserved-height status line shows progress or failure without layout shift. Only newly inserted user rows animate (`Animated`, native driver, ~200 ms opacity plus an 8 pt rise, `theme` durations); a screen-level inserted-ID set prevents virtualization replays; Reduce Motion skips the transform. Assistant output stays left-aligned on the background with no card.

**Desktop.** Desktop Code keeps an independent session list; users reach the same session through Desktop `/resume`. No registry, JSONL, or default-cwd changes.

## Compatibility And Rollback

- Existing clients that omit `model` continue to use the Mac/CLI default.
- Existing session POST and WS frames remain valid.
- If new-session creation fails after a run starts, the response/error pump must
  abort and clean the run; no orphaned active-run entry may remain.
- Rollback is file-scoped: revert the model/session API and frontend feature
  files while preserving existing transcript and config data.
