# @dsh-forge/plugin-quality-gate

Typed quality-gate orchestrator: combines Ruff, Biome, Semgrep, and Trivy
into a single PASS / PASS_WITH_WARNINGS / FAIL verdict.

## Installation

```bash
pnpm add @dsh-forge/plugin-quality-gate
```

## Requirements

- Node.js >= 20
- The upstream binaries for the lanes it probes: `ruff`, `biome`,
  `semgrep`, `trivy` on PATH. Missing binaries mark the corresponding lane
  as skipped (not a gate failure).

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `quality_gate` | network | `path?`, `failOn?: error\|warning\|any`, `maxFindings?: number` (1-5000, default 200) |
| `quality_gate_status` | read | `path?` |

## Result schema

`quality_gate` returns:

- `summary` — the verdict (`PASS` / `PASS_WITH_WARNINGS` / `FAIL`)
- `diagnostics[]` — capped findings
- `summaryBlock`
- `raw` — `{ verdict, failOn, counts, truncated, lanes }`

`quality_gate_status` returns raw `{ language, lanes, total, available }`.

## Permission behavior

- `quality_gate` is `network` (Semgrep/Trivy lanes) and requires permission
  approval.
- `quality_gate_status` is read.

## Lane logic

- python projects → `ruff_check` lane; web projects → `biome_check` lane.
- Always: `trivy_secret_scan` + `semgrep_security_scan` lanes.
- A lane reporting `BinaryNotFound` is skipped; any other lane error makes
  the gate FAIL.

## Example

```text
quality_gate(path: ".")
  → verdict: FAIL (3 errors, 12 warnings)
  → fix lanes
  → quality_gate(path: ".")
  → verdict: PASS
```

## Troubleshooting

- No binary is required for the gate itself; if every lane reports
  `BinaryNotFound`, check the individual plugin installation instructions.

## Compatibility

Tested against Ruff/Biome/Semgrep/Trivy; integration targets the pinned
DeepSeek Harness commit in `compatibility/deepseek-harness.json`.

## License

MIT. Underlying tools remain governed by their upstream licenses.
