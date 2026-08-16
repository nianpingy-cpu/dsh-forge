# @dsh-forge/plugin-ruff

Typed Ruff adapter: lint, format-check, rule explain, fix, and format for
Python projects.

## Installation

```bash
pnpm add @dsh-forge/plugin-ruff
```

## Requirements

- Node.js >= 20
- `ruff` binary on PATH — install with:

```bash
pip install ruff
```

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `ruff_check` | read | `paths: string[]` (required), `select?`, `ignore?` |
| `ruff_format_check` | read | `paths: string[]` (required) |
| `ruff_explain` | read | `code: string` (required) |
| `ruff_fix` | workspace-write | `paths: string[]` (required), `select?`, `ignore?` |
| `ruff_format` | workspace-write | `paths: string[]` (required) |

## Result schema

Read/check tools return `diagnostics[]` (normalized `Diagnostic[]`),
`summaryBlock`, and capped `raw`. `ruff_explain` and `ruff_format` return raw
output only.

## Permission behavior

- `read` tools need no approval.
- `ruff_fix` / `ruff_format` are `workspace-write`: targets are probed
  (read) then validated against the workspace boundary (ADR-005) before the
  write, and require permission approval.

## Example

```text
ruff_check(paths: ["src"])
  → 12 diagnostics
  → ruff_fix(paths: ["src"])
  → ruff_check(paths: ["src"])
  → 0 errors
```

## Troubleshooting

- `BinaryNotFound`: install ruff (`pip install ruff`) and ensure it is on PATH.
- `Timeout`: ruff exceeded the 30s execution timeout; narrow `paths`.
- `ToolFailure`: the output exceeded the 10 MiB cap or ruff itself failed;
  check the `message`.

## Compatibility

Tested against upstream Ruff; pinned project integration targets the
DeepSeek Harness commit in `compatibility/deepseek-harness.json`.

## License

MIT. Ruff remains governed by its upstream license.
