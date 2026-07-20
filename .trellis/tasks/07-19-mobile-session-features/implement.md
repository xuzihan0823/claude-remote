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
