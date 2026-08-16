# @dsh-forge/plugin-uv

Typed uv adapter: Python environment and dependency management —
project status, dependency tree, python discovery, env sync, project run,
and add/remove dependencies.

## Installation

```bash
pnpm add @dsh-forge/plugin-uv
```

## Requirements

- Node.js >= 20
- `uv` binary on PATH — install with:

```bash
pip install uv
```

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `uv_status` | read | `projectDir?` |
| `uv_tree` | read | `projectDir?` |
| `uv_python` | network | `projectDir?` |
| `uv_sync` | network | `projectDir?` |
| `uv_run` | process | `command: string[]` (required, min 1), `projectDir?` |
| `uv_add` | workspace-write | `packages: string[]` (required, min 1), `projectDir?` |
| `uv_remove` | workspace-write | `packages: string[]` (required, min 1), `projectDir?` |

## Result schema

All tools return raw output only (`raw`).

## Permission behavior

Each tool declares its defining side effect as its MutationClass:

- `uv_status` / `uv_tree` → read
- `uv_python` / `uv_sync` → network (resolves/downloads Python or deps)
- `uv_run` → process
- `uv_add` / `uv_remove` → workspace-write (permission-gated)

## Example

```text
uv_status(projectDir: ".")
  → project state
  → uv_add(packages: ["requests"])
  → uv_sync(projectDir: ".")
```

## Troubleshooting

- `BinaryNotFound`: install uv (`pip install uv`) and ensure it is on PATH.

## Compatibility

Tested against uv; integration targets the pinned DeepSeek Harness commit in
`compatibility/deepseek-harness.json`.

## License

MIT. uv remains governed by its upstream license.
