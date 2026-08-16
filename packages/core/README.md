# @dsh-forge/core

Shared SDK for DSH Forge plugins: process runner, binary detection,
diagnostics normalization, workspace policy, permission classification, and
the contract test kit.

## Installation

```bash
pnpm add @dsh-forge/core
```

## Requirements

- Node.js >= 20
- pnpm >= 10 (repo uses pnpm 11)

## What it provides

| Module | Exports |
|---|---|
| `./process/runner` | `runProcess`, `ExecutionRequest`, `ExecutionResult`, `ExecutionError`, `DEFAULT_ENV_ALLOWLIST`, `buildEnv`, `redactSecrets` |
| `./diagnostics/types` | `Diagnostic`, `RawDiagnostic`, `Severity`, `ResultSummary`, `TopIssue`, `toDiagnostic`, `normalizeSeverity`, `parseJsonOutput`, `summarizeDiagnostics` |
| `./workspace/policy` | `MutationClass`, `WorkspaceViolationError`, `DestructiveOperationError`, `resolveInWorkspace`, `classifyMutation`, `assertPermission` |
| `./plugin/types` | `ToolDefinition`, `ToolResult`, `ToolError`, `InputSchema`, `Plugin`, `PluginMetadata`, `validateArgs` |
| `./testing/kit` | `runContractSuite`, `ExecutionRunner`, `ContractCheck`, `ToolArgsSpec`, `renderModelFacing` |

`CORE_VERSION` is exported from the package root and must match every plugin's
`coreContractVersion`.

## Execution rules

1. **No shell.** Typed arguments compile to `argv[]`; `shell: true` is
   forbidden (ADR-004).
2. **Env allowlist.** Third-party CLIs get only `DEFAULT_ENV_ALLOWLIST`
   (PATH, TEMP, HOME, NO_COLOR, ...), never the full inherited environment.
3. **Timeout + output caps** on every execution (default 1 MiB output cap).
4. **Workspace boundary.** Write targets must resolve inside the workspace
   root; `..`, absolute-path escape, and symlink escape are rejected
   (ADR-005).
5. **Permission classification.** Every tool declares a `MutationClass`;
   side-effecting classes require permission approval (ADR-005).

## Result schema

```ts
interface ToolResult {
  ok: boolean
  summary: string            // compact model-facing text
  diagnostics?: Diagnostic[] // normalized findings
  summaryBlock?: ResultSummary
  raw?: string               // capped raw output (reference only)
  error?: { code: string; message: string }
}
```

```ts
interface Diagnostic {
  tool: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  rule?: string
  file?: string
  line?: number
  column?: number
  message: string
  suggestion?: string
  fixable?: boolean
}
```

`ToolError.code` is one of: `InvalidArguments | BinaryNotFound | Timeout |
WorkspaceViolation | PermissionDenied | ToolFailure | ParseFailure`.

## License

MIT.
