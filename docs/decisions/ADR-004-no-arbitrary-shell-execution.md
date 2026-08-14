# ADR-004: No arbitrary shell execution

Status: Accepted

## Context

Wrapping CLIs with `command: string` + `shell: true` invites command
injection and makes arguments unauditable.

## Decision

Tools accept **typed arguments only**, validated against the tool's input
schema and compiled to `argv[]`. `spawn` is always called without a shell.
The repository ESLint config statically rejects `spawn(..., { shell: true })`.
There is no escape hatch and no `execute(command)` API.

## Consequences

+ Injection via tool arguments is structurally impossible.
+ Every execution is inspectable as a typed request.
− Constructs that genuinely require shell features (pipes, globs) must be
  implemented explicitly in typed form or rejected.
