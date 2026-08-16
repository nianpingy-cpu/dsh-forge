# @dsh-forge/plugin-biome

Typed Biome adapter: check, lint, format-check, fix, and format for
JavaScript / TypeScript / JSX / TSX / JSON.

## Installation

```bash
pnpm add @dsh-forge/plugin-biome
```

## Requirements

- Node.js >= 20
- Biome binary — install with:

```bash
npm install -D @biomejs/biome
```

The plugin resolves the `@biomejs/biome` package shim first, then falls back
to `biome` on PATH.

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `biome_check` | read | `paths: string[]` (required) |
| `biome_lint` | read | `paths: string[]` (required) |
| `biome_format_check` | read | `paths: string[]` (required) |
| `biome_fix` | workspace-write | `paths: string[]` (required) |
| `biome_format` | workspace-write | `paths: string[]` (required) |

## Result schema

Check/lint/format-check tools return `diagnostics[]`, `summaryBlock`, and
capped `raw`. `biome_format` returns raw output only. Format-check findings
are normalized as `warning` severity.

## Permission behavior

- `read` tools need no approval.
- `biome_fix` / `biome_format` are `workspace-write`: targets are probed then
  re-validated against the workspace boundary (TOCTOU guard) before the
  write, and require permission approval.

## Example

```text
biome_check(paths: ["src"])
  → diagnostics
  → biome_fix(paths: ["src"])
  → biome_check(paths: ["src"])
  → clean
```

## Troubleshooting

- `BinaryNotFound`: install `@biomejs/biome` or ensure `biome` is on PATH.
- `Timeout`: biome exceeded the 30s execution timeout.

## Compatibility

Tested against Biome; integration targets the pinned DeepSeek Harness commit
in `compatibility/deepseek-harness.json`.

## License

MIT. Biome remains governed by its upstream license.
