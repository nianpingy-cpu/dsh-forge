# @dsh-forge/plugin-semgrep

Typed Semgrep adapter: static source-code security scanning with structured
findings.

## Installation

```bash
pnpm add @dsh-forge/plugin-semgrep
```

## Requirements

- Node.js >= 20
- `semgrep` binary on PATH — install with:

```bash
pip install semgrep
```

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `semgrep_scan` | network | `path?`, `rules?` |
| `semgrep_scan_file` | network | `path: string` (required), `rules?` |
| `semgrep_ruleset` | read | `rules: string` (required) |
| `semgrep_security_scan` | network | `path?`, `rules?` (default `p/security-audit`) |

Registry-style rule sources (`auto`, `secrets`, `supply-chain`, `p/…`,
`r/…`, `c/…`, `x/…`) are passed through; local rule paths are resolved
inside the workspace boundary.

## Result schema

Scan tools return `diagnostics[]`, `summaryBlock`, and capped `raw`.
`semgrep_ruleset` returns raw output only.

## Permission behavior

- Scans are `network` (registry rules / downloads) and require permission
  approval.
- `semgrep_ruleset` is read.

## Example

```text
semgrep_security_scan(path: "src")
  → diagnostics (unsafe APIs, injection, ...)
  → semgrep_scan_file(path: "src/auth.ts", rules: "p/security-audit")
```

## Troubleshooting

- `BinaryNotFound`: install semgrep (`pip install semgrep`) and ensure it is
  on PATH.
- `Timeout`: semgrep scans can be long-running; the plugin raises its
  timeout for real scans.

## Compatibility

Tested against Semgrep; integration targets the pinned DeepSeek Harness
commit in `compatibility/deepseek-harness.json`.

## License

MIT. Semgrep remains governed by its upstream license.
