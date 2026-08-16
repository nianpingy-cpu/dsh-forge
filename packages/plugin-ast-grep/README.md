# @dsh-forge/plugin-ast-grep

Typed ast-grep adapter: structural code search, scan, inspect, rule-test, and
rewrite for JavaScript, TypeScript, JSX, TSX, and Python.

## Installation

```bash
pnpm add @dsh-forge/plugin-ast-grep
```

## Requirements

- Node.js >= 20
- ast-grep binary — install with:

```bash
npm install -D @ast-grep/cli
```

The plugin resolves the `@ast-grep/cli` package binary first, then falls back
to `sg` / `ast-grep` on PATH.

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `ast_search` | read | `pattern: string` (required), `language: js\|jsx\|ts\|tsx\|py` (required), `paths: string[]` (required) |
| `ast_inspect` | read | `pattern` (required), `language` (required), `file: string` (required) |
| `ast_scan` | read | `rule?` (inline YAML), `paths: string[]` (required) |
| `ast_rule_test` | read | `rule` (required), `file` (required) |
| `ast_rewrite` | workspace-write | `mode: preview\|apply` (required), `pattern` (required), `replacement` (required), `language` (required), `paths: string[]` (required) |

## Result schema

Search/scan tools return `diagnostics[]` (info severity) plus `summaryBlock`
and capped `raw`. `ast_inspect`, `ast_rule_test`, and rewrite-apply return raw
output.

## Permission behavior

- Search/scan/inspect/rule-test are `read`.
- `ast_rewrite` is `workspace-write`: `preview` returns proposed edits
  without touching files; `apply` requires permission approval and validates
  every target against the workspace boundary.

## Example

```text
ast_search(pattern: "console.$A", language: "js", paths: ["src"])
  → structural matches with file/line/column
  → ast_rewrite(mode: "apply", pattern: ..., replacement: ..., ...)
```

## Troubleshooting

- `BinaryNotFound`: install `@ast-grep/cli` or ensure `sg` is on PATH.
- `Timeout`: ast-grep exceeded the 30s execution timeout.

## Compatibility

Tested against ast-grep; project integration targets the pinned DeepSeek
Harness commit in `compatibility/deepseek-harness.json`.

## License

MIT. ast-grep remains governed by its upstream license.
