# PROJECT_STATUS

Current Version: 0.0.0 (pre-release)
Current Milestone: V0.1.0
Current Issue: ISSUE-001 (Bootstrap repository)
Current Branch: V0.1.0/issue-001-bootstrap-repository
Current PR: (pending)

Completed Issues: (none)

Open Issues: ISSUE-001 .. ISSUE-030

Blocked: (none)

Latest CI: (pending first PR)

Latest External Review: (pipeline not yet implemented — ISSUE-008)

Next Action: Complete ISSUE-001 TDD loop (RED → GREEN), open PR #1, run CI.

## Branch strategy note

Version branches are named `release/vX.Y.Z` (not `VX.Y.Z`) because git ref
hierarchy plus Windows case-insensitive filesystems make `VX.Y.Z` and
`VX.Y.Z/issue-NNN` mutually exclusive. Issue branches keep the
`VX.Y.Z/issue-NNN-slug` format. Tags remain `vX.Y.Z`.
