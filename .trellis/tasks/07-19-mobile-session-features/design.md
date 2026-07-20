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

- Add a small model-config reader next to daemon configuration. It reads the
  selected model and safe alias/model metadata from the Mac-side settings source
  and returns a redacted catalog. Missing or malformed settings fall back to the
  SDK/CLI default rather than preventing daemon startup.
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

## Compatibility And Rollback

- Existing clients that omit `model` continue to use the Mac/CLI default.
- Existing session POST and WS frames remain valid.
- If new-session creation fails after a run starts, the response/error pump must
  abort and clean the run; no orphaned active-run entry may remain.
- Rollback is file-scoped: revert the model/session API and frontend feature
  files while preserving existing transcript and config data.
