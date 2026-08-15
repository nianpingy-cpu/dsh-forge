# PROJECT_STATUS

Current Version: 0.1.0 (V0.1.0 published — tag v0.1.0)
Current Milestone: V0.2.0
Current Issue: ISSUE-013 MERGED — V0.1.0 integration release (presets + E2E + release)
Current Branch: V0.1.0/issue-009-ast-grep-read-adapter (chain tip)

## Completed (merged + closed with evidence)

- ISSUE-001 bootstrap repository (PR #31)
- ISSUE-002 upstream compatibility lock
- ISSUE-003 architecture standard
- ISSUE-004 core process runner
- ISSUE-005 diagnostics normalization
- ISSUE-006 workspace policy (PR #35)
- ISSUE-007 plugin contract kit (PR #36)
- ISSUE-008 review pipeline (PR #37)
- ISSUE-009 ast-grep read adapter (PR #38)
- ISSUE-010 ast-grep rewrite (PR #40)
- ISSUE-011 Ruff plugin (PR #41)
- ISSUE-012 Biome plugin (PR #42)
- ISSUE-014 uv plugin (PR #43)
- ISSUE-015 act plugin (PR #44)
- ISSUE-016 Semgrep plugin (PR #45)
- ISSUE-017 Trivy plugin (PR #46)
- ISSUE-020 Docker read-only (PR #47)
- ISSUE-021 Docker stateful (PR #48)
- ISSUE-022 k6 plugin (PR #49)
- ISSUE-023 FFmpeg plugin (PR #50, 13 review rounds, approve conf 0.82)
- **ISSUE-013 V0.1.0 integration release** (PR #51): presets `@dsh-forge/presets`
  (coding/python/web), deterministic no-API E2E + real DSH host-shim E2E,
  fresh-clone verification, tag v0.1.0 + GitHub Release

## Plugins implemented (10)

ast-grep · Ruff · Biome · uv · act · Semgrep · Trivy · Docker · k6 · FFmpeg — plus
`@dsh-forge/core` (runner, diagnostics, workspace policy, contract kit) and
`@dsh-forge/presets`.

## Open Issues (in dependency order)

- ISSUE-018 Quality and security gate (quality_gate orchestration tool)
- ISSUE-025 Full E2E suite (five stories: Ruff/Semgrep/act/Docker+k6/FFmpeg)
- ISSUE-024 Presets full set (coding/python/web/security/devops/media/full)
- ISSUE-019 V0.2.0 release (security+devops presets, tag v0.2.0)
- ISSUE-026 V0.3.0 release
- ISSUE-027 DeepSeek Harness compatibility matrix (Pinned + Latest lanes)
- ISSUE-028 Documentation and examples
- ISSUE-029 Supply chain and release hardening
- ISSUE-030 V1.0.0 release

## Quality signals

- Tests: 470 passing (21 files), typecheck/lint/build clean
- CI: verify (ubuntu-latest + windows-latest, node 22) PASS
- Every plugin PR reviewed by an independent external model (DeepSeek via local
  claude CLI) before merge; review artifacts committed under `reviews/`
- All completion states proven by runnable tests / CI / real tool execution

## Branch strategy note

Version branches are named `release/vX.Y.Z` (not `VX.Y.Z`) because git ref
hierarchy plus Windows case-insensitive filesystems make `VX.Y.Z` and
`VX.Y.Z/issue-NNN` mutually exclusive. Issue branches keep the
`VX.Y.Z/issue-NNN-slug` format. Tags remain `vX.Y.Z`.
