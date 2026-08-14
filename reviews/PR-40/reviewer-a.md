# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.72

## Blocking
(none)

## Non-blocking
- packages/plugin-ast-grep/src/index.ts (astRewrite apply): probe→apply TOCTOU. Targets are boundary-verified from probe output, but the apply re-runs sg minutes/milliseconds later against the same canonical paths. A file at a verified canonical path can be swapped for a symlink to an outside file between probe and apply; `--update-all` will then write through it. The canonical-path return from resolveInWorkspace closes the user-path symlink swap but not the target-inode swap. Narrow race, but it is the exact workspace-escape the issue lists.
- packages/plugin-ast-grep/src/index.ts (astRewrite preview): matched files are NOT boundary-verified in preview mode. If the user path is a directory containing a symlink that points outside the workspace, sg follows it, and the outside file's matched `text`/`replacement` is returned in diagnostics and raw. Read-side path traversal, inconsistent with the apply branch which verifies every match. Read-only and pre-existing in ast_search/ast_scan, but cheap to fix (reuse the apply verification loop) and directly relevant to the issue's 'path traversal' security consideration.
- packages/plugin-ast-grep/src/index.ts (noMatchIsOk): a real apply failure that exits 1 with both streams empty is masked as a clean no-op, and the tool then reports the probe's match count as 'rewrite applied to N changes across M files' — a fabricated success claim. Reachable when probe matches but apply finds no matches (files changed between probe and apply, or replacement is a semantic no-op like replacement == matched text). The summary should derive from apply results or at least not claim applied changes it cannot verify.
- packages/core/src/plugin/types.ts validateArgs: array item types are not validated. `paths: [42]` passes validation (type 'array', minItems satisfied) and then crashes inside resolveInWorkspace with an unhandled TypeError (`42.replace` on win32 / `path.resolve(root, 42)` on POSIX) instead of returning InvalidArguments. The PR extends validateArgs (minItems) but not per-item type checks; the new tool inherits the pre-existing gap.
- packages/plugin-ast-grep/src/index.ts (runSg + probe): the 1 MiB default output cap is not accounted for. On a large workspace rewrite the `--json=pretty` probe/preview output is truncated mid-JSON, parseJsonOutput returns ParseFailure, and apply is blocked entirely. No maxOutputBytes override or streamed/paginated handling, so the tool's primary use case (multi-file rewrites) fails on large match sets.
- packages/plugin-ast-grep/src/index.ts (runSg): exit-code heuristic treats any non-zero exit with JSON-looking stdout as success. sg exit code 2 (real error) with `[]` on stdout would be parsed as 0 matches and reported as '0 changes' in probe/apply/preview, masking a real failure. Pre-existing in runSg, but the new apply probe inherits it.
- packages/plugin-ast-grep/src/index.ts: resolveInWorkspace uses realpathSync, which does not detect hard links. A file inside the workspace that is a hard link to an outside file passes the boundary check, and apply rewrites the shared inode, modifying the outside file. Git cannot carry hard links, so this requires local creation, but it is an unguarded escape vector for the workspace-write boundary.
- packages/plugin-ast-grep/src/index.ts: probe logic (~60 lines) is duplicated between the preview and apply branches; divergence already introduced the preview boundary gap. Should be a single helper that returns verified matches.
- packages/plugin-ast-grep/src/index.ts (astRewrite.execute): `await import("node:fs")` for existsSync on every invocation; minor, could be hoisted.
- packages/plugin-ast-grep/src/index.ts: no concurrency control between concurrent applies on overlapping files; interleaved `--update-all` invocations can race and produce lost updates or partial writes.

## Security
- Apply TOCTOU: verified target files can be swapped to symlinks between probe and apply, letting a rewrite escape the workspace (see non_blocking #1).
- Preview does not boundary-verify matched files; a symlinked directory inside the workspace can leak outside-file content (matched text + replacement) into diagnostics/raw (see non_blocking #2).
- Hard-link bypass of the realpath-based boundary check (see non_blocking #7).
- noMatchIsOk can mask a genuine apply failure as a false 'N changes applied' success (see non_blocking #3).
- WorkspaceViolation error path discloses the matched file's real path (err.message includes the outside target path); minor info disclosure, not blocking.

## Test gaps
- No test exercises the noMatchIsOk masked path (probe matches + apply exits 1 with empty streams), nor the resulting false-success summary. The 'no matching pattern' test short-circuits at the probe and never reaches the apply no-match branch.
- No test for permission context absent (ctx.permission undefined → denied); only `{ approved: false }` is covered.
- No test for non-string array items (`paths: [42]`) — currently an unhandled TypeError, not InvalidArguments.
- No test for preview read-side symlink escape (directory with symlink to outside); only the apply-side is mocked.
- No test for large output/truncation → ParseFailure behavior.
- No test for concurrent applies on the same file.
- The end-to-end symlink test asserts only that the outside secret is unchanged and `void result`; it never asserts the ToolResult, so it passes whether sg skips symlinks, blocks them, or writes nothing — the boundary logic is not actually proven by it.
- No test pins the ast-grep version/SHA whose behaviors the PR depends on (`replacement` JSON field, `--update-all` exit-1-empty-output); a silent upstream behavior change would break preview/apply without CI catching the version drift.

## Compatibility
- DSH manifest states permission_hook_api is TBD; `PermissionContext { approved: boolean }` on ToolContext is an assumption about the DSH host. It fails safe (absent context ⇒ denied), so apply is inoperative until DSH wires the permission context — the 'DSH registration verified' acceptance criterion cannot be met yet.
- Preview/apply depend on specific ast-grep CLI semantics (JSON `replacement` field, `--update-all` exit code/output on no-match) that are not pinned to a version in tests; behavior may differ across ast-grep releases.
- mutationClass is declared `workspace-write`, so a DSH host that gates at the tool level (before execute) would also block read-only preview calls, contradicting the in-tool design where preview needs no approval. Ownership of the permission gate (host vs tool) is ambiguous.
- toRelativeFile uses raw startsWith; on Windows sg reports forward-slash paths while workspaceRoot is backslash-separated, so preview diagnostics carry absolute file paths instead of workspace-relative ones (cosmetic).

## Architecture
- The contract kit does not enforce that workspace-write tools actually call assertPermission; a tool declaring workspace-write that never gates would still pass the suite. The kit should verify mutation side effects are gated.
- Probe/verification logic duplicated between preview and apply branches, inviting the divergence already observed (preview missing the boundary check).
- Docs were not updated in this PR despite the issue requiring documentation updates in the same PR; the changed-file list contains only types.ts, index.ts, and the test file.
- permission gate is placed before path validation in apply, so a denied request never surfaces WorkspaceViolation for invalid paths; acceptable, but means error precedence differs by permission state.
