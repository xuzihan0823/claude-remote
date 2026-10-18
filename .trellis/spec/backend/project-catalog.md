# Project Catalog and Session Filtering

## 1. Scope / Trigger

Applies to the daemon's authenticated project projection and mobile conversation browsing. JSONL transcripts remain the source of truth; no project registry or filesystem browser is introduced.

## 2. Signatures

- `GET /api/projects`
- `GET /api/sessions?limit=100&offset=0&projectId=<encoded>&cwd=<encoded>`
- `POST /api/sessions` continues accepting the original known `cwd`.
- Client: `fetchProjects()` and `fetchSessions(limit = 100, { offset = 0, projectId, cwd } = {})` in `web/core/api.js`.

## 3. Contracts

Catalog response: `{ projects: [{ id, name, cwd, cwds, sessionCount, lastActiveAt }], totalSessions, unclassifiedCount, homeCwd }`. `homeCwd` is the daemon host's user home directory and is always a valid new-session target, matching a CLI launched from home.

Projects are aggregated from the entire transcript index before pagination. For Git working directories, identify the shared repository root so linked worktrees belong to one project. On Git discovery failure, retain the original full cwd. Distinct repositories with equal basenames remain distinct. `name` is presentation only; never use it as identity.

`cwds` contains only original nonempty working directories observed in indexed sessions. `cwd` is a recently active member of `cwds`, not an inferred repository root. Project grouping must never silently change the directory passed to the SDK. Unknown-cwd sessions count toward `totalSessions` and `unclassifiedCount` but do not become runnable project targets.

An absent `projectId` selects all sessions. An empty `projectId` selects missing-cwd sessions. Nonempty IDs select the matching catalog project. An optional `cwd` further intersects the selection. Apply all filters before `offset` and `limit`; `total` counts the filtered set. Existing unfiltered calls and SessionSummary fields remain compatible.

Git discovery uses argument-based child process execution, bounded time/output, and only indexed cwd values. Do not interpolate paths into shell commands. Missing directories degrade to a cwd-based project rather than failing the catalog.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Missing/invalid bearer token | 401 unauthorized |
| Unknown project ID | 200 empty sessions and total 0 |
| Missing cwd in old transcript | Available through all/unclassified browsing |
| Git discovery fails | Preserve full original cwd identity |
| Create uses unrecognized cwd | Existing 400 unknown_cwd |
| Filter path contains spaces, Unicode, ampersand, hash | URL-encode and preserve literal value |

## 5. Good / Base / Bad Cases

- Good: main workspace and linked worktree share a project; new from a worktree conversation uses that worktree's original cwd.
- Base: a non-Git directory appears as one project keyed by its full cwd.
- Bad: deriving projects from only the most recent 100 sessions loses old projects; grouping by basename merges unrelated directories.

## 6. Tests Required

Assert repository/worktree aggregation, ordinary directories, equal names with different IDs, missing/deleted cwd fallback, counts, ordering, and filtering before pagination. Exercise authenticated HTTP endpoints and legacy unfiltered requests. Assert unknown IDs return an empty page and empty projectId selects unclassified sessions. Client tests must preserve encoded paths and reject cache writes from a previous connection's response.

## 7. Wrong vs Correct

Wrong: `groupBy(sessions.slice(0, 100), basename)` and `startTurn({ cwd: project.id })`.

Correct: aggregate the complete index with repository-aware identities, paginate the selected project, and start with an explicitly selected original member of `project.cwds`.
