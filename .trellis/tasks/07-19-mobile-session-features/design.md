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

## Compatibility And Rollback

- Existing clients that omit `model` continue to use the Mac/CLI default.
- Existing session POST and WS frames remain valid.
- If new-session creation fails after a run starts, the response/error pump must
  abort and clean the run; no orphaned active-run entry may remain.
- Rollback is file-scoped: revert the model/session API and frontend feature
  files while preserving existing transcript and config data.
