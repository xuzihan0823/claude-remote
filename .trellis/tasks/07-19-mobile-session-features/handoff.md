# Mobile Session Features Handoff

## Start Here

Read these files in order:

1. `prd.md` — requirements, confirmed repository facts, acceptance criteria,
   resolved model behavior, and out-of-scope items.
2. `design.md` — cross-layer data flow, API shapes, lifecycle, compatibility,
   and rollback boundaries.
3. `implement.md` — ordered work, parallel file ownership, validation commands,
   and review gates.
4. `docs/api-contract.md`, `PROGRESS.md`, and the relevant source files before
   editing.

Active Trellis task: `.trellis/tasks/07-19-mobile-session-features`

## Product Decision

The phone model selector is a per-turn override. When no override is selected,
the next turn follows the Mac-side Claude default. Never write phone choices to
`~/.claude/settings.json` in this task.

## Parallel Roles

### Backend/SDK Agent

Own `packages/agent-bridge/**`, `packages/daemon/**`, and backend tests. Add the
redacted model projection, optional SDK model/session ID, new-session API,
session abort API, validation, and integration tests. Do not edit `web/**` or
`ios/**`.

### Web/Mobile Agent

Own `web/app.js`, `web/style.css`, `web/index.html`, and Web mock fixtures only
if needed. Add the Claude-style new-chat start screen, known-project selector,
model selector, new-session flow, and active-run stop control. Do not edit
daemon or iOS project files.

### Branding/iOS Agent

Own `web/icons/**`, the icon generator, and
`ios/App/App/Assets.xcassets/**` plus Capacitor-synced public assets. Replace
the inline six-ray mark with the supplied twelve-ray style and ensure the
marketing icon is opaque. Do not change API behavior.

## Integration Rules

- All agents share one worktree. Do not revert other agents' changes.
- Preserve existing API behavior when `model` is omitted.
- Use existing Preact, node:test, TypeScript, and Capacitor patterns; add no
  runtime dependency without a documented reason.
- The primary window owns `docs/api-contract.md`, final integration, full test
  runs, simulator verification, Release archive verification, and commit.
