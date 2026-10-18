# Native Project Conversations

## 1. Scope / Trigger

Applies to `app/src/` project browsing and new-conversation targeting. Read the backend [project catalog contract](../backend/project-catalog.md) before changing payloads.

## 2. Signatures

Consume `fetchProjects()` and `fetchSessions(limit, { offset, projectId, cwd })` from `web/core/api.js`. `NewChatComposer` receives an explicit actual working directory; it must not choose `projects[0]` internally.

## 3. Contracts

Keep the drawer's browsing filter separate from the new-conversation target. All/unclassified are browsing choices, never executable directories. Project IDs identify repository groups; only original `cwds` from the catalog are valid execution targets.

Home displays the target and allows project/workspace selection. New from an existing conversation inherits its original cwd, including linked worktrees; a missing cwd leaves the target empty rather than inheriting an unrelated previous project. When neither a stored target nor a project preference exists, default to the catalog's `homeCwd` (the daemon host's home directory), label it as the home directory, treat it as known, and expose the same choice in the target picker. Catalog refresh must not silently replace an explicit target, even when it has become unavailable. Capture the target when submitting, before attachment uploads or other awaits. If the connection changes during upload, stop before POSTing to another daemon.

Shared project state is scoped to the connected daemon. Connection identity changes must be reactive even when auth stays `ok`; importing mutable base/token variables alone does not trigger a React render. Clear old session caches and guard asynchronous results from an old connection or project filter. Never persist a bearer token in preference keys.

Refresh catalog/list on reconnect and foreground; coalesce activity refreshes rather than refetching for every streamed message. Preserve live status updates on optimistic summaries across catalog/cache refreshes until an authoritative server row replaces them or the optimistic TTL expires. Paginated rows deduplicate by sessionId; refresh must invalidate stale pagination responses and replace authoritative rows instead of retaining deleted sessions indefinitely. Empty pages still use the server's `total`. New-session optimistic state tolerates the delay between POST acceptance and JSONL creation.

The native drawer presents the complete project catalog as expandable groups in one virtualized list. Expansion must not call `selectProject` or change the Home target. Create group-specific `createSessionPager` instances lazily; preserve cached pages when collapsed, invalidate them on shared refresh, and refetch only expanded groups. Use explicit group-level pagination because the global list end does not identify which project needs another page. Preserve the empty-string Unclassified filter; it is not the null All filter.

Default expansion reads the complete root navigation state (`NavigationContainerRefContext` / `getRootState()` with a state subscription), not only the Drawer props' potentially incomplete nested state. Resolve the active Chat leaf route and its cached/optimistic session cwd; Home opens the most recent project, or Unclassified when it is the only group. A missing cache entry is unresolved metadata, not a missing-cwd session. Once a user collapses a project, catalog polling or the first late-arriving Home route must not reopen it. Dispose all group pagers on connection remount and entries removed by an authoritative catalog; late results must not publish.

Project-header creation uses Home's existing `fromCwd` plus fresh `nonce` route parameters with a catalog actual cwd, not the repository-group ID. Existing draft preservation/target feedback still applies. Unclassified has no creation action. Keep current-session selection, status, and actual workspace context accessible even when repeated ordinary project paths are omitted.

Project switching changes browsing only. Global approval delivery and active runs remain independent.

## 4. Validation & Error Matrix

| Condition | UI behavior |
| --- | --- |
| No stored target and no project preference | Default to `homeCwd`, show it explicitly |
| No known runnable directory | Explain project selection; disable send |
| Catalog/list request fails | Keep useful content when available and offer retry |
| Old connection/filter response finishes late | Discard it |
| Two projects share a name | Show path context |
| One project has several workspaces | Display and allow explicit actual cwd selection |
| Old session has no cwd | Remain browsable; require target selection for a new chat |

## 5. Good / Base / Bad Cases

- Good: new from a worktree chat keeps that exact workspace even when another project becomes more active.
- Base: a single-directory project offers its sole known target.
- Bad: a background refresh changes the directory while a user is composing.

## 6. Tests Required

Verify encoded project filters, unclassified/all distinction, pagination and deduplication, connection/filter races, draft target stability, and new-from-chat cwd propagation. For grouped browsing assert zero session requests for untouched collapsed groups, independent offsets, stale-cache refresh on reopening, manual collapse surviving polling, and ignored responses after disposal. Export the iOS Hermes bundle; exercise native controls in a supported runtime when available. Web daemon preview verifies HTTP/client requests, not native-only UI behavior.

## 7. Wrong vs Correct

Wrong: `const cwd = projects[0]` inside the composer or `cwd = project.id` when starting a worktree chat.

Correct: resolve an explicitly selected original workspace in the project state, show it to the user, and pass that cwd into the composer submission.
