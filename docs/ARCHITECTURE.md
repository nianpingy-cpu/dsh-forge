# dsh-forge Architecture

## Goal

Turn mature developer CLIs into typed, safe, structured DeepSeek Harness (DSH)
tools — not shell wrappers.

```
DeepSeek Harness
      ↓
Typed Tool
      ↓
Safe Adapter
      ↓
Structured Execution
      ↓
Normalized Result
      ↓
Agent Reasoning
      ↓
Fix / Retry / Verify
```

## Monorepo layout

- `packages/core` — the shared SDK: process runner, binary detection,
  diagnostics, workspace policy, permission classification, contract test kit.
- `packages/plugin-*` — one package per upstream tool (ast-grep, Ruff, ...).
  Plugins contain **no** duplicated infrastructure code.
- `presets/` — composition/configuration only (coding, python, web, security,
  devops, media, full). Presets never copy plugin code.
- `compatibility/` — pinned upstream DSH manifest (see ADR-002 context).
- `scripts/` — verify-upstream, review-pr, test-plugin.
- `reviews/PR-N/` — external model review artifacts.

## Core concepts

| Concept | Meaning |
|---|---|
| `BinaryInfo` | Detected upstream binary: name, resolved path, version, source (PATH / explicit). |
| `ExecutionRequest` | Typed execution: binary, argv[], cwd, env allowlist, timeout, AbortSignal, max output, redaction patterns. |
| `ExecutionResult` | exit code, stdout/stderr (captured, capped, redacted), timedOut/aborted/truncated flags, duration. |
| `Diagnostic` | Normalized finding: tool, severity, rule, file/line/column, message, suggestion, fixable. |
| `ResultSummary` | Compressed model-facing view: counts by severity, top issues, truncated flag, raw reference. |
| `MutationClass` | `read` \| `workspace-write` \| `network` \| `process` \| `system-change` \| `destructive`. |
| `Capability` | What a plugin/tool can do (languages, formats, modes). |
| `PluginMetadata` | Name, version, upstream tool, core contract version, capabilities. |

## Data flow (every plugin)

1. **Validate** typed arguments against the tool's schema; reject invalid input
   before any subprocess runs.
2. **Classify** the mutation; side-effecting classes require DSH permission
   approval before execution.
3. **Resolve** the binary; a missing binary is a `BinaryNotFound` tool error —
   never a silent fallback.
4. **Execute** via the core process runner (`spawn` without a shell, env
   allowlist, timeout, output caps, redaction).
5. **Normalize** structured CLI output into `Diagnostic[]` + `ResultSummary`;
   raw output is kept as a reference, not returned wholesale to the model.
6. **Render** a compact model-facing result.

## Upstream compatibility

DSH is in developer preview. `compatibility/deepseek-harness.json` pins the
exact commit all integration work targets (ADR-002). CI prints the pinned SHA;
upgrades require a manifest update plus re-verification.

## Decisions

See `docs/decisions/` (ADR-001 .. ADR-006).
