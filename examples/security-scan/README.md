# Example: security-scan

Semgrep + Trivy + quality-gate security workflow.

## Scenario

Run source-code, secret, and container/config security scans over a project.

## Required binaries

- `semgrep` — `pip install semgrep`
- `trivy` — <https://github.com/aquasecurity/trivy/releases>
- `ruff` / `biome` — used by the quality gate lanes

## Steps

```text
1. semgrep_security_scan(path: "src")     # network: source audit
2. trivy_secret_scan(path: ".")           # read: secrets (raw omitted, redacted)
3. trivy_config_scan(path: "deploy/")     # network: IaC misconfig
4. trivy_sbom(path: ".")                  # network: SBOM + licenses
5. quality_gate(path: ".")                # network: combined verdict
```

## Expected result

Security findings are normalized, secrets are never echoed, and the quality
gate reports a PASS / PASS_WITH_WARNINGS / FAIL verdict.

## Permissions

Network scans require permission approval; `trivy_secret_scan` is read-only.
