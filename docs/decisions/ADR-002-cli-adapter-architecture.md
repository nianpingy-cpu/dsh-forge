# ADR-002: CLI adapter architecture with pinned upstream compatibility

Status: Accepted

## Context

DSH is in developer preview with explicit compatibility-breaking changes
warned upstream. dsh-forge wraps ten external CLIs that each have their own
release cadence.

## Decision

1. Every plugin is an *adapter*: typed arguments → validated → `argv[]` →
   core process runner → normalized `Diagnostic[]`/`ToolResult`.
2. All DSH integration work targets the exact commit recorded in
   `compatibility/deepseek-harness.json`; `scripts/verify-upstream.ts`
   validates the manifest and CI prints the pinned SHA.
3. Upgrading the pin requires a manifest update and re-running the
   compatibility tests.

## Consequences

+ Deterministic integration surface despite upstream churn.
+ Adapter core is unit-testable with mocked runners and fixture outputs.
− Pin upgrades are deliberate work, not automatic.
