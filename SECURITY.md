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
