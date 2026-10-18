# Mobile model switching, interrupts, new sessions, and Claude-style start screen

## Goal

Make the Capacitor iOS app a usable mobile front end for Claude Code, not only a
viewer for existing transcripts: the user can start a conversation, select a
model exposed by the Mac-side Claude configuration, stop a running turn, and
continue using the same Mac project/session truth.

## Background And Confirmed Facts

- The phone stores only the daemon base URL and bearer token in browser storage
  (`web/app.js`); it does not copy Mac configuration JSON to the phone.
- The Mac currently has a Claude model setting (`~/.claude/settings.json` is
  configured with `model: fable`). The daemon starts the Claude Agent SDK on the
  Mac and currently omits an explicit `model` option, so the SDK uses the Mac
  CLI default for a turn.
- `TurnRunner.abort(runId)` already exists, but the HTTP server has no public
  abort endpoint or stop control.
- The API currently reads existing sessions and posts messages to an existing
  `sessionId`; there is no new-session endpoint or new-chat route.
- The installed Claude Agent SDK supports `model`, an explicit `sessionId`,
  `setModel`, and `supportedModels()` in streaming mode.
- The UI `Spark` component is a six-ray mark. The existing app icon PNG is
  already a twelve-ray mark close to the supplied reference image.

## Requirements

### R1. Mac-backed model catalog and selection

- Add an authenticated API projection of model configuration that contains only
  model identifiers, aliases, and display metadata; never return auth tokens or
  arbitrary environment values.
- The phone UI shows the Mac-backed model catalog and the current default.
- When Mac settings provide `modelPicker.options`, expose every valid configured
  model in order, preserve labels, and deduplicate by the full model ID. Different
  provider prefixes identify different models. If no valid picker options exist,
  retain the legacy alias catalog.
- Keep built-in aliases compatible as per-turn inputs. Project only model IDs,
  aliases, and display names; do not expose picker descriptions or credentials.
- A selected model is passed to the next SDK turn. By default, when no phone
  override is selected, the next turn uses the current Mac-side default.
- Do not write `~/.claude/settings.json` from the phone in the MVP unless the
  product decision below explicitly changes this requirement.

### R2. Interrupt a running turn

- Add an authenticated, idempotent stop operation for the active run of a
  session.
- The stop operation must call the existing Runner abort path, emit the normal
  `run` terminal error with `error: "aborted"`, close the SDK query, and return
  the session to an idle/available state.
- The mobile composer changes from send to a clear stop action while a run is
  active and recovers after success, duplicate stop, or an already-finished run.

### R3. Start a new session from the phone

- Add an authenticated API for creating a new session with an explicit UUID,
  selected known project `cwd`, initial text, and optional model.
- The response identifies the new `sessionId` and `runId` so the client can
  navigate immediately and subscribe to the transcript as it is created.
- MVP project selection is limited to known project directories already exposed
  by the daemon; arbitrary filesystem paths and new-project provisioning are out
  of scope.
- The new session must be persisted in `~/.claude/projects` and remain resumable
  from the terminal and from the mobile session list.

### R4. Claude-style mobile start screen

- On mobile, the initial authenticated view presents a new-chat composer first,
  followed by recent sessions; it must not force the user to open an old session
  before typing.
- The composer includes model selection, project selection, attachment support
  consistent with the existing composer, and a stop state while running.
- Existing desktop sidebar/list, chat history, approval cards, and settings
  workflows remain usable.

### R5. Brand mark

- Replace the inline six-ray `Spark` mark with a twelve-ray mark matching the supplied reference. Keep Web/PWA/iOS icon assets visually consistent.
- Preserve a non-transparent, App Store-compatible iOS marketing icon.

### R6. Project-scoped mobile conversations (authorized 2026-10-18)

- Provide an all-conversations view and a project selector in the native mobile drawer. Projects and their counts must come from the complete daemon index, not a truncated client page.
- Selecting a project filters its conversations before pagination; older conversations remain reachable. Missing-cwd sessions remain accessible as Unclassified.
- Group Git worktrees of the same repository under one project, but preserve and display each session's actual working directory. Non-Git directories remain distinct by full path; equal basenames never merge.
- New conversations visibly target a known working directory. New from a conversation inherits that conversation's cwd; new from a selected project uses its selected/recent known workspace. Allow explicit project/workspace selection on Home.
- Changing the browsing project never aborts a run or hides global approvals. Local project preferences are scoped to the connected daemon, with no credentials persisted in preference keys.
- Keep JSONL transcripts as the source of truth, preserve the known-cwd create allowlist, and add no project database or arbitrary directory execution.
- Verify repository/worktree aggregation, filter-before-pagination totals, unknown projects, unclassified data, refresh races, and explicit new-session cwd propagation.

### R7. Expandable project sidebar (approved 2026-10-18)

- Replace the native drawer's flat list and project filter with expandable project groups matching the supplied reference. Multiple groups may remain open.
- Each project header shows its name, disclosure state, complete session count, and a separate new-conversation action. Unclassified sessions remain browsable without a project creation action.
- Default to the current conversation's project, or the most recent project on Home. Respect subsequent manual collapse across refreshes.
- Indent conversations, distinguish the selected conversation, and retain status/time and actual workspace context for multi-workspace projects. Avoid repeating the project path on every ordinary row.
- Expansion changes browsing only. Project creation targets an actual known cwd, preserves drafts with existing feedback, and leaves workspace selection available on Home.
- Preserve the existing brand header, refresh, bottom settings/new-chat actions, global approvals, active runs, and complete per-project pagination. Fetch groups lazily and isolate pagination, errors, and stale responses per project.

## Acceptance Criteria

- [ ] `GET /api/models` (or the agreed equivalent) returns the Mac-backed model
      catalog without credentials; its default reflects the current Mac config.
- [ ] A phone-selected model is observed in the SDK query options for the next
      turn; clearing the selection returns to the Mac default.
- [ ] A running mobile turn can be stopped from the phone; the run reaches an
      `aborted` terminal event, the UI exits the running state, and a second stop
      is a safe no-op/conflict response.
- [ ] The phone can create a session in a known project, receive its first
      transcript, navigate to it, and the session appears in `GET /api/sessions`.
- [ ] The new-chat composer is the first useful mobile content and does not
      overlap the recent-session list or safe-area insets on the iOS simulator.
- [ ] The new mark appears in the welcome page, chat avatar, PWA icon, and iOS
      app icon; the iOS marketing icon has no alpha channel.
- [ ] API, Runner, SDK bridge, frontend behavior, and cross-layer integration
      tests cover success, invalid input, busy/abort races, unknown model/cwd,
      and reconnect behavior.
- [ ] `pnpm typecheck`, `pnpm test`, Capacitor sync, simulator Debug build/run,
      and unsigned Release device archive all pass.

### R6 Acceptance

- [x] Catalog counts cover the complete index, including projects absent from the first session page.
- [x] Main checkout and linked worktree aggregate together; two separate repositories with the same name remain separate.
- [x] Project and unclassified filters return correct totals and reachable older pages without duplicate rows.
- [ ] Home visibly selects a known actual cwd; new-from-chat preserves that chat's workspace.
- [x] Reconnect, project switching, and delayed-response safeguards have focused regressions; native interaction remains subject to device acceptance.
- [ ] Existing creation allowlist, global approvals, active runs, model selection, and attachments remain compatible.

## Out Of Scope

- Writing arbitrary Mac settings, API credentials, or environment variables from
  the phone.
- Arbitrary filesystem path execution, project creation, or multi-user access
  control beyond the existing bearer token.
- Native SwiftUI rewrite, App Store submission, Apple signing, or TestFlight
  distribution in this task.

## Resolved Product Decision

Phone model selection is a **per-turn override**. Clearing the phone selection
uses the current Mac-side default for the next turn. The phone must not write
back to `~/.claude/settings.json` in this task, so remote model selection cannot
silently change terminal-wide behavior.
