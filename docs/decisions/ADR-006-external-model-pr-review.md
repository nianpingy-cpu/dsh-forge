# ADR-006: External model PR review

Status: Accepted

## Context

The implementing agent must never be the sole reviewer. Reviews must be
independent, evidenced, and free of secrets.

## Decision

1. Every PR requires at least one external (non-implementer) model review
   before merge; two reviewers (correctness/security + design/testing) when
   configured.
2. `scripts/review-pr.ts` builds the review prompt from the issue, acceptance
   criteria, diff, changed files, test results, architecture/security rules,
   and the DSH compatibility manifest — never just the PR title.
3. Reviewers return structured JSON (`verdict`, `blocking`, `non_blocking`,
   `security`, `test_gaps`, `compatibility`, `architecture`, `confidence`).
   Artifacts are stored under `reviews/PR-N/`.
4. Providers are configurable (`REVIEWER_A_*`, `REVIEWER_B_*` env). API keys
   never enter Git or artifacts. CI unit tests use mocked APIs only.
5. No external reviewer available ⇒ PR stays BLOCKED. Reviews are never
   fabricated.

## Consequences

+ Independent quality gate with durable evidence.
− Merge throughput depends on reviewer availability; blocked PRs are the
  honest failure mode.
