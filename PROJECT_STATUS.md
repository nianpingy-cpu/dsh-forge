# PROJECT_STATUS

Current Version: 0.0.0 (pre-release)
Current Milestone: V0.1.0
Current Issue: ISSUE-009 (ast-grep read adapter) — development complete, PR open
Current Branch: V0.1.0/issue-009-ast-grep-read-adapter
Current PR: #38 (ISSUE-009 → ISSUE-008 branch; stacked chain #31→#32→#33→#34→#35→#36→#37→#38)

Completed Issues (development): ISSUE-001..ISSUE-009 (RED+GREEN evidence in PRs #31-#38)

Open Issues: ISSUE-010 .. ISSUE-030 (ISSUE-010 ast-grep rewrite is next)

Blocked: All merges — external reviewer API key not yet configured (REVIEWER_A_* env vars). Per ADR-006 no PR may merge without at least one external model review. Development continues on stacked branches per blocker policy.

Latest CI: PASS — PR #38, ubuntu-latest + windows-latest (92/92 tests incl. real ast-grep integration)

Latest External Review: Pipeline implemented (ISSUE-008, PR #37) with mocked tests; awaiting real reviewer credentials

Next Action: Configure REVIEWER_A_* env vars → run external reviews on PR chain #31..#38 → merge in order → close Issues #1..#9 → start ISSUE-010 (ast_rewrite + DSH integration).

## Branch strategy note

Version branches are named `release/vX.Y.Z` (not `VX.Y.Z`) because git ref
hierarchy plus Windows case-insensitive filesystems make `VX.Y.Z` and
`VX.Y.Z/issue-NNN` mutually exclusive. Issue branches keep the
`VX.Y.Z/issue-NNN-slug` format. Tags remain `vX.Y.Z`.
