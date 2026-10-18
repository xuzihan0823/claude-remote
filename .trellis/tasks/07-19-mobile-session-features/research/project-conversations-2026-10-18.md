# Project-scoped native conversations — 2026-10-18

## Scope and implementation

The user requested exploration, then explicitly asked to complete the proposed feature. R6 extends the existing in-progress mobile task; it does not authorize unrelated commits, task archiving, or overwriting concurrent changes.

- Added complete-index project catalog and project/cwd filtering before pagination.
- Linked Git worktrees share a repository project; original indexed cwd values remain the only runnable targets. Equal repository names do not merge.
- Added native project/workspace bottom sheets, drawer filtering/pagination, explicit Home cwd, and new-from-chat inheritance.
- Added connection-scoped project state, stale-response protection, draft-target preservation, and optimistic newly created rows.
- Preserved existing model/permission/keyboard changes in the dirty worktree.

## Verification evidence

Before final integrated review, `pnpm test` passed 134 tests: Web client 3, native pure logic 9, interactions 7, agent bridge 13, daemon 102. `pnpm typecheck` passed. `git diff --check` passed. The native worker exported the iOS Hermes bundle successfully with `NODE_PATH` set to `app/node_modules`.

A Release generic iOS build passed using the existing native workspace and `/tmp/claude-remote-release-dd`. Build log: `output/project-verification/ios-release-build.log`. This is an unsigned build, not proof of installation or native interaction.

An isolated preview daemon on port 8791 used generated transcripts and temporary Git workspaces under ignored `output/project-verification/`. It returned 108 total sessions: 106 in a repository with two workspaces, 1 in an independent same-name repository, and 1 unclassified. Project paging returned 100 plus 6 rows with no overlap; unknown project returned total 0. Authenticated catalog returned 200; unauthenticated returned 401. Shared browser API imports preserved request parameters. The fixture server was stopped after verification and its temporary launch entry removed.

The actual daemon on port 8788 was gracefully restarted after checking that none of its sessions had daemon-driving status. Read-only checks after restart returned 10 projects and 60 sessions with matching aggregate counts, correct project filtering, HTTP 401 without credentials, and the existing 25-model catalog intact. No real model inference was triggered.

## Verification limits

Expo's mandated SDK 57 online documentation was inaccessible through WebFetch and curl; implementation reused installed dependencies and existing native patterns.

Automatic approval review rejected the attempted simulator UI test preparation/run because it could mutate shared simulator state. The action was not retried through another execution path. Native clicks, layout, keyboard placement, VoiceOver, and actual phone installation remain unverified. A read-only connected-device app query also failed because the device connection was reset.

The finish-work skill requires committing current-task code before task archiving and journal auto-commits. No git commit was requested, so this session preserves uncommitted changes and leaves the broader task active.

## Final integration review

The integrated checker found and addressed stale pagination/refresh handling, explicit target fallback, and cross-connection upload/request races. The revised pager replaces the authoritative loaded range, trusts server totals even for empty pages, and invalidates overlapping requests. Explicit unavailable cwd values stay visible until changed; new from an unclassified conversation clears the execution target. New connection probing happens before committing global credentials, and uploads stop if the connection changes. Focused regressions were added for these behaviors. After these changes, `pnpm test` passed 143 tests: Web client 5, native pure logic 16, interactions 7, agent bridge 13, daemon 102. `pnpm typecheck` and `git diff --check` passed again. The final Release generic iOS rebuild also passed after the review fixes (`output/project-verification/ios-release-build-final.log`); source timestamps were checked against the bundled artifact. The integrated checker reported no remaining confirmed defects after the five fixes. No phone installation or simulator interaction was performed. An unsigned app archive was delivered as `output/project-conversations/ClaudeRemote-projects-unsigned.app.zip`.
