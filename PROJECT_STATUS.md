# PROJECT_STATUS

Current Version: 0.0.0 (pre-release)
Current Milestone: V0.1.0
Current Issue: ISSUE-001 (Bootstrap repository)
Current Branch: V0.1.0/issue-001-bootstrap-repository
Current PR: #31 (ISSUE-001: Bootstrap repository → release/v0.1.0)

Completed Issues: (none)

Open Issues: ISSUE-001 .. ISSUE-030

Blocked: PR #31 merge gate — external model review pending (no reviewer API configured yet; pipeline arrives in ISSUE-008)

Latest CI: PASS (PR #31, ubuntu-latest + windows-latest, 2026-08-14)

Latest External Review: (pipeline not yet implemented — ISSUE-008)

Next Action: Obtain external reviewer configuration, complete review of PR #31, merge, proceed to ISSUE-002.

## Branch strategy note

Version branches are named `release/vX.Y.Z` (not `VX.Y.Z`) because git ref
hierarchy plus Windows case-insensitive filesystems make `VX.Y.Z` and
`VX.Y.Z/issue-NNN` mutually exclusive. Issue branches keep the
`VX.Y.Z/issue-NNN-slug` format. Tags remain `vX.Y.Z`.
