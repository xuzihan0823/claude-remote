# Implementation Plan

## Ordered Checklist

1. Confirm the model persistence decision and freeze the API contract.
2. Extend the SDK bridge and Runner for optional model and explicit new-session
   IDs; add unit tests for resume vs. new-session option construction.
3. Add daemon model projection, new-session endpoint, active-session abort route,
   validation, and integration tests.
4. Update the API contract and shared error/event documentation.
5. Refactor the Web composer/start screen for new sessions, model/cwd selection,
   and stop behavior; add browser/mock coverage where the project permits.
6. Replace the inline Spark mark and regenerate/sync PWA/iOS icon assets.
7. Run typecheck/tests, start the daemon, verify new session/model/abort flows,
   sync Capacitor, run the iOS simulator, and produce an unsigned Release
   device archive.
8. Review cross-layer payloads, unknown model/cwd handling, reconnect races,
   and working-tree ownership before committing.

## Parallel Ownership

- Backend/SDK: `packages/agent-bridge/**`, `packages/daemon/**`, and backend
  contract tests. No Web or iOS asset edits.
- Web/mobile: `web/app.js`, `web/style.css`, `web/index.html`, and Web mock/test
  fixtures if needed. No daemon or iOS project edits.
- Branding/iOS: `web/icons/**`, icon generator, `ios/App/App/Assets.xcassets/**`,
  and Capacitor sync output. No API behavior edits.
- Primary window: task artifacts, API contract integration, final merge, full
  tests, simulator/device build, and conflict resolution.

## Model Catalog Fix (2026-10-18)

The user authorized this bounded repair after reviewing the diagnosed cause and
proposed backend-only approach.

1. Extend the daemon reader to project `modelPicker.options`, preserve labels and
   order, deduplicate full IDs, and preserve defaults and legacy alias inputs.
2. Add focused regressions for picker coverage, invalid entries, duplicates,
   redaction, defaults, legacy fallback, and alias compatibility.
3. Exercise the reader through HTTP integration tests with a fake SDK: GET lists
   configured models, POST forwards the selected ID, and unknown IDs are rejected.
4. Run daemon tests and workspace typecheck, then independently review this fix.
   Do not modify concurrent frontend work or send paid model requests.
5. Compare the real configuration with the fixed reader. After confirming no
   daemon-driven turn is active, restart the local daemon and verify all current
   configured options appear in the live API. No phone rebuild is needed.

## Project Conversations (2026-10-18)

1. Backend owns `packages/daemon/**`: add repository/worktree project projection, authenticated catalog, filter-before-pagination, and focused unit/HTTP regressions. Preserve all concurrent model changes.
2. Frontend owns `app/src/**`: shared project context, project/workspace picker, drawer filtering/pagination, explicit Home target, and new-from-chat inheritance. Preserve existing style, modes, attachments, and keyboard behavior.
3. Main session owns `web/core/api.js`, API documentation, task manifests, integration verification, and native export/build validation. Do not send real model requests just to test targeting.
4. Run `pnpm test` (including Web request and mobile pure-logic regressions) and `pnpm typecheck`, bundle native JS from `app/` with `NODE_PATH="$PWD/node_modules" npx expo export --platform ios`, review once across the full feature, then address confirmed findings. Exercise actual UI when a native runtime is available; browser preview cannot stand in for native-only modules.
5. Restart the local preview daemon only after checking active runs, then verify catalog/filter responses read-only. Build a distributable native artifact where the installed toolchain permits it; report precise verification limits.

## Expandable Native Sidebar (approved 2026-10-18)

1. Add a pure project-group controller and thin hook reusing the existing session pager, catalog, merge/filter helpers and cached session metadata. Keep expansion separate from new-chat targeting.
2. Replace Drawer filter/flat rows with a single virtualized project tree. Preserve header/footer identity, selected session, accessibility, independent project creation and explicit group pagination/errors.
3. Add focused mobile regressions for lazy independent paging, collapse/cache invalidation, stale responses/disposal, default expansion, unclassified/worktree membership and optimistic deduplication.
4. Run mobile tests and Expo iOS export; build/run the actual RN app from `app/ios/ClaudeRemote.xcworkspace` on the available iPhone simulator. Capture native evidence and report any unavailable interaction checks precisely. Do not use the legacy Capacitor validation commands below for this RN change or issue paid model requests.
5. Review the integrated diff, update the project-conversations spec where necessary, and request explicit consent before any Git commit. Leave the pre-existing untracked launch configuration untouched.

R7 verification completed: mobile tests 29/29, workspace typecheck and full baseline tests passed; Expo iOS export and final Release simulator build passed. Native XCTest passed grouped browsing, default/collapse refresh behavior, 50 → 100 → 106 pagination, Unclassified, same-name projects and project-specific Home targeting (2/2 cases). Light-mode XXXL capture passed (1/1). Evidence: `output/sidebar-verification/verification.md` and adjacent native screenshots. No real model turn was submitted. Git commit remains pending explicit user authorization.

## Home Directory Default (2026-10-18)

1. Add `homeCwd` to the authenticated project catalog and accept it in new-session cwd validation; keep repository-root and arbitrary-path rejection unchanged.
2. Fall back to `homeCwd` on Home only when no stored or project-derived target exists; keep explicit/inherited/empty targets and catalog-failure behavior unchanged.
3. Show the home target as `主目录 (~)`, treat it as known, and add the same option to the target picker without duplicating a future home project group.
4. Run daemon server tests, mobile tests, and workspace typecheck; rebuild the native app and confirm the default target on the simulator without submitting a model turn.
5. Restart the local daemon before device use so `/api/projects` serves `homeCwd`. Do not commit or deploy without explicit user authorization.

Home-default verification: daemon server tests assert `homeCwd` in the catalog and successful creation in the home directory; mobile tests and `pnpm typecheck` pass; full workspace tests pass (Web 5, mobile 29, interactions 7, agent-bridge 13, daemon 102). A clean simulator install connected to the fixture daemon defaulted Home to `主目录 (~)` with the home picker option selected (`testHomeTargetDefaultsToHomeDirectory`, 1/1). No model turn was submitted. The running daemon still needs a restart, and the new app build needs authorization before commit/push/device install.

## Chat Reliability And Streaming (approved 2026-10-19)

Coding is dispatched to the Haiku tier (`coder-deepseek`); the main session owns design, integration, and final verification. Each block owns disjoint files and must be dispatched with a prompt starting `Active task: .trellis/tasks/07-19-mobile-session-features`.

1. A1 transcript: `packages/daemon/src/transcript/{types.ts,reader.ts}` project optional `apiMessageId`; extend reader tests.
2. A2 agent-bridge: `packages/agent-bridge/src/{types.ts,event-adapter.ts,sdk-bridge.ts}` add `StreamTracker`, `assistant_delta` identity, and SDK input `uuid`; tests for multiple blocks/wrappers.
3. A3 runner: `packages/daemon/src/run/runner.ts` accept `clientMessageId`, keep the bounded per-run stream buffer, expose a snapshot reader.
4. A4 server: `packages/daemon/src/server.ts` — optional `clientMessageId`/`sessionId` on POST, abort runId guard, `GET messages` `status`/`activeRunId`, ping/pong, subscribe ack, stream broadcast and snapshot. Extend `packages/daemon/__tests__/server.test.ts`.
5. A5 watcher: `packages/daemon/src/watch/watcher.ts` shared initialization Promise with ready semantics; tests for concurrent subscribe/unsubscribe/close.
6. B shared client: `web/core/{api.js,ws.js}`, new `web/core/conversation-state.js` (send state machine, reconciliation, transient stream items), and `web/ui/screens/chat.js`; node regressions.
7. C native UI: `app/src/screens/ChatScreen.js`, `app/src/components/MessageRow.js`, `app/src/components/composer/{ChatComposer.js,NewChatComposer.js}`, `app/src/screens/HomeScreen.js`, `app/src/lib/format.js`; reuse `theme.js` and RN `Animated`, no new dependency.
8. Integration review: protocol round-trip, generation/run guards, stream replacement, no double bubbles, Reduce Motion, safe-area/keyboard behavior preserved. Then run workspace tests/typecheck, mock streaming scenarios, Expo export, and an iOS simulator build with native evidence under `output/chat-message-verification/`. No paid model request, no commit without explicit authorization.

## Validation Commands

```bash
pnpm typecheck
pnpm test
pnpm dev
npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug \
  -destination 'id=<simulator-udid>' \
  -derivedDataPath /tmp/claude-remote-dd CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/ClaudeRemote.xcarchive CODE_SIGNING_ALLOWED=NO archive
```

## Review Gates

- Do not expose secrets while projecting settings.
- Do not allow a mobile-selected cwd outside the known workspace projection.
- Abort must settle the same completion/event path as normal and error runs.
- The new composer must respect safe-area insets and mobile keyboard resizing.
- The marketing icon must be opaque before the final archive check.

### Chat Reliability And Streaming — Verification (2026-10-19)

- Workspace checks: `pnpm test` passed — web 28/28, mobile 29/29, interactions 7/7, agent-bridge 18/18, daemon 119/119; `pnpm typecheck` clean.
- Web end-to-end (mock daemon): local bubble appears immediately, 202 switches it to accepted, official echo replaces the same key in place (always one bubble); real streaming text grew 50 → 114 → 189 → 213 chars and the run bar disappeared at the end; forced WS drop reconnected and resumed streaming without duplicates; dropped 202 showed "发送结果待确认" and was reconciled by the echo without resending.
- Native XCTest (iPhone 17, iOS 26.5, Release build, mock daemon):
  - `testUserBubbleDirectionAndSingleConfirmation` passed — user bubble right-aligned with status subtitle, exactly one bubble after confirmation, reply left-aligned; timed screenshots at 2 s / 3 s / 4 s show the reply growing (`同一 seq 的 thi` while "Claude 正在运行…" is still visible, later the full body with code block).
  - `testIdenticalTextSentTwiceStaysTwoBubbles` passed — sending the identical text twice keeps exactly two distinct bubbles.
  - `testLargeTextDarkLayout` passed — dark mode at accessibility-extra-extra-extra-large: composer hittable, user bubble right-aligned, not clipped by screen edges or composer.
  - Reduce Motion enabled (simulator `ReduceMotionEnabled=1`): the duplicate-send test still passed (no crash, no duplicate, correct layout).
- Test-harness notes: XCTest element queries wait for app quiescence, so mid-stream content is sampled with timed screenshots instead of element queries. The RN accessibility tree duplicates each text node (outer/inner StaticText), so bubble counts de-duplicate by frame. Mock session state persists per process, so each run uses a unique message text.
- Mock fixture additions (test-only): `GET /api/projects`, `MOCK_APPROVAL_INTERVAL_MS=0` to disable the fake approval ticker during UI tests.
- No real paid model request was issued. Git commit remains pending explicit user authorization.
