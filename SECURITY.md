# Security Policy

## Supported versions

Pre-release development. Security fixes apply to the default branch and active release branches.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" in the Security tab of this repository). Do not open
public issues for suspected vulnerabilities.

## Security model

- **No arbitrary shell execution.** Every tool accepts typed arguments that are validated and compiled to `argv[]`. `shell: true` is forbidden (ADR-004).
- **Workspace boundary.** Write operations verify target paths stay inside the workspace; traversal, absolute-path escape, and symlink escape are rejected by default (ISSUE-006).
- **Environment allowlists.** Third-party CLIs never inherit the full environment; sensitive values are redacted from captured output.
- **Permission classification.** Every tool declares a `MutationClass`; side-effecting operations go through the DeepSeek Harness permission system (ADR-005).
- **Binary detection, not redistribution.** Plugins detect and invoke installed binaries; upstream binaries are not redistributed without license review (ISSUE-029).

## Supply chain and release hardening (ISSUE-029)

The `supply-chain` CI job (and `pnpm supply-chain`) runs the packaging gates
before every release:

- **Secret scan** of built artifacts (`dist/`) — API keys, tokens, private
  keys, and connection-string patterns fail the build.
- **Package contents allowlist** — built packages ship only tsup artifacts
  (`*.js`, `*.js.map`, `*.d.ts`); unexpected files fail the check.
- **No redistributed binaries** — committed `.exe`/`.dll`/`.so`/`.dylib`/etc.
  are rejected; plugins detect and invoke installed binaries instead.
- **Lockfile discipline** — `pnpm-lock.yaml` must be committed and non-empty;
  CI installs with `--frozen-lockfile`.
- **License allowlist** — workspace manifests may use only permissive
  licenses (MIT, Apache-2.0, BSD, ISC).
- **SBOM + artifact checksums** — a timestamped SBOM and SHA-256 checksum
  manifest are generated under `compatibility/reports/` and uploaded as CI
  artifacts for provenance and artifact verification.

`pnpm audit` is run locally/CI on production deps and must report no known
vulnerabilities.
