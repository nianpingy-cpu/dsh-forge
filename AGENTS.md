# AGENTS.md

Rules for AI coding agents working in this repository. These rules are binding.

## Process

1. Work one GitHub issue at a time, in dependency order. Never implement multiple unrelated issues in one PR.
2. Follow strict TDD: RED (failing test, committed) → GREEN (minimal implementation, committed) → REFACTOR (separate commit, tests stay green).
3. A RED failure must be a missing-feature failure, not an import/syntax/setup error (except where an issue explicitly defines otherwise, e.g. bootstrap).
4. Never delete, skip, or weaken a test to make CI green. Never mark real failures as expected.
5. Review findings are fixed via regression TDD: failing regression test first, then the fix.
6. Update `PROJECT_STATUS.md` after every merge.

## Security (non-negotiable)

1. No arbitrary shell execution. `shell: true` is forbidden. Tools take typed arguments compiled to `argv[]` (ADR-004).
2. All write operations must verify the target path stays inside the workspace (ADR-005 / ISSUE-006).
3. Never inherit the full environment into third-party CLIs. Use env allowlists.
4. Never commit secrets, API keys, or `.env` files.
5. Side-effecting tools declare `MutationClass` and go through the DeepSeek Harness permission system.

## Git

1. Conventional Commits only (`test(scope):`, `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `chore(scope):`, `ci(scope):`).
2. Branching: `main` → `release/vX.Y.Z` → `VX.Y.Z/issue-NNN-slug`. PRs target the version branch, never `main` directly.
3. Reference the issue number in every commit message: `(#N)`.

## Review

1. The implementing agent must never be the sole reviewer. Every PR requires at least one external (non-implementer) model review before merge.
2. Never fabricate a review. If no external reviewer is configured, the PR stays blocked.
3. Review artifacts live under `reviews/PR-N/` and must never contain secrets.

## Upstream compatibility

DeepSeek Harness is in developer preview. All plugin work targets the commit pinned in `compatibility/deepseek-harness.json`. Verify the manifest before touching integration code.
