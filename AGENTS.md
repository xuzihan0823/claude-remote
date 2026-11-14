# AGENTS.md

Rules for AI coding agents working in `claude-remote`.
`CLAUDE.md` mirrors this file via `@AGENTS.md`. Treat every change as production maintenance on a live system.

Optimize in strict order:
1. Correctness
2. User data & credential safety
3. Security boundaries
4. Protocol & state compatibility
5. Architectural integrity
6. Testability & maintainability
7. Delivery speed

---

## 1. Interaction & Read Before Changing

- Reply in the language the user used (e.g., Chinese when asked in Chinese).
- At session start, check `gh pr list`, `git worktree list`, and `git status --short` to understand active work.
- Read the nearest `AGENTS.md` (e.g., `app/AGENTS.md`), `docs/architecture.md`, and the target source and tests before editing.
- **Source of truth** is current code, types, `package.json`, and tests. If documentation contradicts implementation, verify the code first and report the drift.
- Only ask the user when ambiguity affects public contracts, UI/copy, data compatibility, or irreversible actions; otherwise proceed with the smallest reversible assumption.

---

## 2. Frozen Architecture & Security Boundaries

- **Session data**: `~/.claude/projects/**/*.jsonl` is **read-only** to the daemon; writes occur only naturally via Claude Code / Agent SDK `--resume`. Never mutate JSONL history directly from the daemon.
- **Fail-closed approvals**: Timeout, disconnect, daemon restart, or unexpected error must **deny**. Never introduce auto-approve paths.
- **Loopback pairing guard**: `/api/pair-info` and `/api/pair-qr.svg` are local-only and double-protected by `looksProxied()` and relay connector `PAIR_PATHS` (returning `403` via any relay/proxy). Any new local-only endpoint must also be added to `PAIR_PATHS`; never trust `127.0.0.1` source address alone.
- **Relay protocol**: Share framing via `@claude-remote/relay/protocol` between `packages/relay` and `packages/daemon/src/relay/connector.ts`; do not duplicate parsers.
- **No browser client**: Root and static web paths return `404`. (`web/core/` holds shared mobile logic and tests.)

---

## 3. Multi-Agent Isolation & Git Hygiene

- **1 task = 1 branch + 1 dedicated worktree** from latest `main` (`type/short-description`). Never develop directly on `main`, switch branches in another agent's worktree, or touch unrelated work.
- **Hard prohibitions** (never run without explicit user request for that exact command):
  ```text
  git reset --hard
  git checkout .
  git clean -fd
  git stash          # worktrees share one stash list
  git add .
  git add -A
  git commit --no-verify
  ```
- Stage explicit file paths only, and inspect `git diff --cached` before committing.
- **Never force-push or rewrite history** without explicit user authorization.
- **2026-10-31 history rewrite**: Do not push or merge clones/branches created before 2026-10-31; cherry-pick needed commits only after checking for secrets.
- When opening/updating a PR, state goal, rationale, behavior changes, verified checks, and unverified items in the PR description (do not create separate shared progress files). Once merged, delete the branch and worktree.

---

## 4. Public Repository & Commit Rules

This repository is **public**. Anything pushed must be treated as permanently public.

- **Never commit** credentials, secrets, tokens, real server IPs or domains, personal emails, Apple Team / certificate / account IDs, or real machine hostnames. Use placeholders (`<RELAY_HOST>`, `example.com`, `203.0.113.x`) in docs and tests.
- **Never commit** build artifacts, dependencies, `.env`, local databases, or logs (keep them in `.gitignore`).
- Use your GitHub `noreply` email for commits, never a personal email.
- Commit format: `type(scope): concise summary` (`scope` optional).

---

## 5. Scope, Frontend, & Async Safety

- Keep diffs small, single-purpose, and free of drive-by refactors or mass formatting.
- **Frontend / mobile UI rule**: Do not modify UI pages, buttons, entry points, or copy unless explicitly requested; when fixing bugs, keep the UI untouched whenever possible. Ask the user before adding new UI pages, buttons, or user-facing copy.
- **Async & lifecycle safety**: Never assume state is unchanged across `await` (SDK turns, CLI presence polling, WebSocket heartbeats, relay connectors, approval timers). Every watcher, timer, socket, and child process must have an explicit cleanup path.
- Never bypass errors or TypeScript checks (`any`, `as any`, `@ts-ignore`, `@ts-nocheck`).

---

## 6. Validation & Delivery Report

- Unified test runner: `node:test` / `tsx --test` (`pnpm test`, `pnpm typecheck`). Do not mix in additional test frameworks.
- **Minimum bar by change type**:
  - *Bug fix*: reproduce or add a failing regression test first, fix, and pass relevant tests + typecheck.
  - *Feature / contract change*: cover user path and boundary/failure cases + typecheck.
  - *Docs / copy only*: verify all referenced paths, symbols, commands, and links exist; no unit tests required.
- Never use real user daemons, live relay servers, or paid model APIs as default test environments without explicit authorization.
- In your final response, report only observed file paths, behavior, and checks actually run after the final edit; clearly list any skipped checks and unverified paths.
