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
