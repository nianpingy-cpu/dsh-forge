# Contributing to dsh-forge

Thank you for contributing!

## Prerequisites

- Node.js >= 20
- pnpm >= 10 (`corepack enable`)

## Setup

```bash
git clone https://github.com/nianpingy-cpu/dsh-forge.git
cd dsh-forge
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Development workflow

1. Find or create an issue. Every change maps to exactly one issue.
2. Create a branch from the active version branch: `VX.Y.Z/issue-NNN-slug`.
3. Follow TDD strictly:
   - Write a failing test that proves the missing behavior. Run it, confirm it fails for the right reason, commit `test(scope): ... (#N)`.
   - Write the minimal implementation. Run tests, typecheck, lint. Commit `feat(scope): ... (#N)`.
   - Refactor only with green tests, in a separate `refactor(scope): ... (#N)` commit.
4. Open a PR against the version branch (never `main` directly) using the PR template, including RED/GREEN evidence.
5. CI must pass and an external model review must complete with zero blocking findings before merge.

## Commit convention

Conventional Commits: `test|feat|fix|refactor|docs|chore|ci(scope): summary (#issue)`.

## Security rules for contributors

- No `shell: true`. Typed arguments → `argv[]` only.
- Write operations must stay inside the workspace boundary.
- No secrets in code, logs, tests, or review artifacts.

Report security vulnerabilities privately — see [SECURITY.md](SECURITY.md).
