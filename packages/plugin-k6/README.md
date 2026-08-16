# @dsh-forge/plugin-k6

Typed k6 adapter: performance and load testing — smoke, load, stress,
threshold checks, and summary parsing.

## Installation

```bash
pnpm add @dsh-forge/plugin-k6
```

## Requirements

- Node.js >= 20
- `k6` binary on PATH — see <https://github.com/grafana/k6/releases>

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `k6_version` | read | — |
| `k6_run` | process | `script: string` (required), `vus?`, `duration?` |
| `k6_smoke` | process | `script` (required), `duration?` (default 30s) |
| `k6_load` | process | `script` (required), `vus?` (default 50), `duration?` (default 2m) |
| `k6_stress` | process | `script` (required), `vus?` (default 200), `duration?` (default 5m) |
| `k6_summary` | read | `path: string` (required, summary-export JSON) |
| `k6_threshold_check` | read | `path: string` (required) |

`duration` accepts `\d+(ms|s|m|h)` with a practical upper bound (~28.5m).

## Result schema

All tools return raw output only (redacted). k6 exit semantics: 0 = pass,
1 = thresholds not met (still a completed run), other = error.

## Permission behavior

- Run tools are `process` and require permission approval.
- `k6_version`, `k6_summary`, `k6_threshold_check` are read (pure parsers).

## Example

```text
k6_smoke(script: "tests/smoke.js")
  → pass/fail
  → k6_load(script: "tests/load.js", vus: 50, duration: "2m")
  → k6_threshold_check(path: "summary.json")
```

## Troubleshooting

- `BinaryNotFound`: install k6 from the releases page and ensure it is on
  PATH.

## Compatibility

Tested against k6; integration targets the pinned DeepSeek Harness commit in
`compatibility/deepseek-harness.json`.

## License

MIT. k6 remains governed by its upstream license.
