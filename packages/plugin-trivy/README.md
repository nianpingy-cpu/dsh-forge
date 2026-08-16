# @dsh-forge/plugin-trivy

Typed Trivy adapter: supply-chain and container security — filesystem,
config, secret, image scans, and SBOM.

## Installation

```bash
pnpm add @dsh-forge/plugin-trivy
```

## Requirements

- Node.js >= 20
- `trivy` binary on PATH — see
  <https://github.com/aquasecurity/trivy/releases>

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `trivy_repo_scan` | network | `repo: string` (required, URL or workspace path) |
| `trivy_config_scan` | network | `path: string` (required) |
| `trivy_secret_scan` | read | `path: string` (required) |
| `trivy_image_scan` | network | `image: string` (required) |
| `trivy_sbom` | network | `path: string` (required) |

## Result schema

Scan tools return `diagnostics[]` (prefixed `vuln:` / `misconfig:` /
`secret:` / `license:`), `summaryBlock`, and capped `raw`. The secret scan
deliberately omits `raw` and redacts credential/secret values; diagnostics
are capped at 1000.

## Permission behavior

- `trivy_secret_scan` is read (offline).
- Other scans are `network` and require permission approval.
- Trivy runs in an isolated temp runtime dir (no `.trivyignore` injection).

## Example

```text
trivy_secret_scan(path: ".")
  → secret findings (raw omitted, values redacted)
  → trivy_repo_scan(repo: ".")
  → vuln + misconfig findings
```

## Troubleshooting

- `BinaryNotFound`: install trivy from the releases page and ensure it is on
  PATH.

## Compatibility

Tested against Trivy; integration targets the pinned DeepSeek Harness commit
in `compatibility/deepseek-harness.json`.

## License

MIT. Trivy remains governed by its upstream license.
