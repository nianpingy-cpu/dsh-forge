# ADR-005: Permission classification and workspace boundary

Status: Accepted

## Context

Tools range from pure readers to destructive operations. The harness must be
able to gate side effects, and file writes must never escape the workspace.

## Decision

1. Every tool declares a `MutationClass`:
   `read | workspace-write | network | process | system-change | destructive`.
2. Classes other than `read` require DSH permission approval before
   execution; `destructive` additionally passes a destructive-operation guard.
3. All write targets are resolved against the workspace root; `..` escape,
   absolute-path escape, and symlink escape are rejected by default.
4. Destructive upstream commands (e.g. `docker system prune`, forced
   removals) are not exposed unless a separate high-risk API is designed.

## Consequences

+ Side effects are explicit, auditable, and gated by the harness.
− Some powerful workflows require explicit user authorization steps.
