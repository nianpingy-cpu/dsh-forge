# PROJECT_STATUS

Current Version: 0.0.0 (pre-release)
Current Milestone: V0.1.0
Current Issue: ISSUE-001 MERGED — reviewing PR chain #32..#38
Current Branch: V0.1.0/issue-009-ast-grep-read-adapter (chain tip)
Current PR: #31 MERGED (ISSUE-001); #32..#38 open (ISSUE-003..#009)

Completed Issues: ISSUE-001 (merged via PR #31 into release/v0.1.0)

Open Issues: ISSUE-002 .. ISSUE-030 (ISSUE-010 ast-grep rewrite next after chain)

Blocked: (none) — external reviewer now configured (DeepSeek via local claude CLI)

Latest CI: PASS — release/v0.1.0 + all open PR branches

Latest External Review: PR #31 APPROVE (5 rounds: 4 real ADR-004 security fixes + 1 review-input enhancement; artifacts reviews/PR-31/)

Next Action: Review + merge PR chain #32..#38 in order (external model review per PR), then ISSUE-002/#002 PR, then ISSUE-010.

## Branch strategy note

Version branches are named `release/vX.Y.Z` (not `VX.Y.Z`) because git ref
hierarchy plus Windows case-insensitive filesystems make `VX.Y.Z` and
`VX.Y.Z/issue-NNN` mutually exclusive. Issue branches keep the
`VX.Y.Z/issue-NNN-slug` format. Tags remain `vX.Y.Z`.
