# @dsh-forge/plugin-act

Typed act adapter: list and run GitHub Actions workflows locally via Docker.

## Installation

```bash
pnpm add @dsh-forge/plugin-act
```

## Requirements

- Node.js >= 20
- `act` binary — download from <https://github.com/nektos/act/releases>
- Docker (required for dry-run / run / run-job)

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `act_list_workflows` | read | — |
| `act_list_jobs` | read | — |
| `act_dry_run` | process | — |
| `act_run` | system-change | — |
| `act_run_job` | system-change | `jobId: string` (required) |
| `act_failure_summary` | read | `log: string` (required) |

## Result schema

All tools return raw output only (`raw`). `act_failure_summary` is a pure
parser — it needs no binary.

## Permission behavior

- `act_list_*` and `act_failure_summary` are read.
- `act_dry_run` is process (needs Docker).
- `act_run` / `act_run_job` are `system-change` (Docker + explicit
  permission approval).

Each run executes in an isolated temporary runtime dir (no `.actrc`
injection) with an empty HOME, and a pinned platform-image mapping.

## Example

```text
act_list_workflows()
  → workflow list
  → act_run()
  → workflow result
```

## Troubleshooting

- `BinaryNotFound`: download act from the releases page; if Docker is
  missing, run tools report a dedicated `docker unavailable` result rather
  than a generic workflow failure.

## Compatibility

Tested against act; integration targets the pinned DeepSeek Harness commit in
`compatibility/deepseek-harness.json`.

## License

MIT. act remains governed by its upstream license.
