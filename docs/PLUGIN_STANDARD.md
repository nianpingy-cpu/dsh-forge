# Plugin Standard

Every dsh-forge plugin package MUST satisfy this contract. The contract test
kit (`@dsh-forge/core` `testing` module) enforces it mechanically.

## Package requirements

- Package name: `@dsh-forge/plugin-<tool>`.
- Exports a default `Plugin` object: `{ metadata, tools }`.
- `metadata: PluginMetadata` — name, version, upstream tool + version tested
  against, `coreContractVersion` (must equal `CORE_VERSION`), capabilities.
- No infrastructure duplication: process execution, binary detection,
  diagnostics normalization, workspace checks, and permission classification
  come from `@dsh-forge/core`. A plugin that spawns its own processes or parses
  its own paths fails review.

## Tool requirements

Each tool in `tools` is a `ToolDefinition`:

- `name` — snake_case, prefixed with the tool family (`ast_search`,
  `ruff_check`).
- `description` — what it does, for the model.
- `mutationClass: MutationClass` — one of
  `read | workspace-write | network | process | system-change | destructive`.
- `inputSchema` — JSON-Schema-like typed argument schema. Tools MUST NOT
  accept free-form command strings.
- `execute(args, ctx)` — validates args against the schema, then runs the
  adapter. Returns a canonical `ToolResult`.

### MutationClass semantics

| Class | Meaning | Gate |
|---|---|---|
| `read` | No side effects outside the process | none |
| `workspace-write` | Writes inside the workspace only | workspace boundary + DSH permission |
| `network` | Network access | DSH permission |
| `process` | Runs/arbitrary long-lived processes | DSH permission |
| `system-change` | Changes outside the workspace (containers, installs) | DSH permission, explicit |
| `destructive` | Irreversible destruction | DSH permission + destructive guard; avoid exposing |

## Execution rules (binding)

1. **No shell.** Arguments are typed values compiled to `argv[]`; `shell: true`
   is forbidden (ADR-004, enforced by ESLint).
2. **Env allowlist.** Third-party CLIs receive only allowlisted environment
   variables, never the full inherited environment.
3. **Timeout + output caps** on every execution.
4. **Binary detection.** Missing binary ⇒ `BinaryNotFound` tool error with the
   binary name and install hint. No silent fallbacks.
5. **Workspace boundary.** Any write target must resolve inside the workspace
   root; `..` escape, absolute-path escape, and symlink escape are rejected
   (ADR-005).
6. **Structured output first.** Prefer the upstream CLI's machine-readable
   output (JSON). Terminal-text regex parsing is a last resort and must be
   flagged in review.

## Result contract

`ToolResult`:

- `ok: boolean`
- `summary: string` — compact model-facing text
- `diagnostics?: Diagnostic[]` — normalized findings
- `summaryBlock?: ResultSummary` — for large diagnostic sets
- `raw?: string` — capped raw output (reference only)
- `error?: { code: string; message: string }` — normalized, e.g.
  `BinaryNotFound`, `InvalidArguments`, `Timeout`, `WorkspaceViolation`,
  `PermissionDenied`, `ToolFailure`

## Test requirements

Every plugin package MUST pass the shared contract test kit:

- plugin loads; tools register with unique names
- input schema valid; typed args accepted; invalid args rejected
- canonical result returned; model-facing summary rendered
- tool errors normalized; permission classes declared correctly
- binary-missing path returns `BinaryNotFound`

Integration tests run the real upstream binary against committed fixtures.
