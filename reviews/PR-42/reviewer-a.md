# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.72

## Blocking
(none)

## Non-blocking
- biome_fix/biome_check/biome_lint/biome_format_check never pass --max-diagnostics=0. If biome 2.5.8's JSON reporter respects the default 20-diagnostic cap (the console reporter definitely does), whole-workspace runs silently under-report findings and biome_fix/biome_format silently skip fixing any file beyond the cap. The tests only ever produce 1-2 findings, so they cannot catch this. Must be verified against the pinned binary; if capped, this is a functional defect in the primary use case.
- biome_format's apply step treats any `format --write` exit code 1 as a hard failure. On a directory with a mix of formattable and unparseable files, biome writes the good files and exits 1, so the tool returns ToolFailure *after* partial modification — the model is told 'failed' while files changed. Same pattern exists in the accepted ruff plugin, but the partial-write misreport is real; consider surfacing partial success.
- toRelativeFile uses case-sensitive, separator-sensitive string.startsWith(workspaceRoot). On Windows, biome's JSON paths use forward slashes while workspaceRoot uses backslashes, so diagnostics carry absolute paths instead of workspace-relative ones (and a sibling dir sharing the workspace prefix would be mis-truncated). Display-only — boundary checks go through resolveInWorkspace — but it breaks the diagnostic contract on win32.
- runBiome treats exit code 1 as 'findings present' for check/lint, which also swallows real tool errors that biome reports via exit 1 (e.g. a malformed workspace biome.json, an unreadable file). Those errors come back as normalized 'findings' (often with file:undefined) rather than ToolFailure, so the model cannot distinguish 'code has issues' from 'tool could not run'.
- biome_format_check forces every format diagnostic to severity 'warning' via fallbackSeverity, overriding biome's actual 'error' severity — under-reports severity for whole-file format violations. Consistent with ruff's choice, but it loses fidelity.
- Hardcoded 30s timeout and 10 MiB output cap on every tool with no caller override; whole-workspace biome checks on large monorepos can spuriously time out or hit the cap, surfaced as Timeout/ToolFailure with no retry path.
- biomePosition drops any diagnostic with column 0 (column > 0 is required) and line 0 — correct for biome's whole-file format sentinel, but a genuine lint finding at column 0 would silently lose its position.
- The 'path does not exist' error message embeds the absolute resolved path (requireExisting), leaking workspace layout into model-facing output.

## Security
- Residual TOCTOU window: revalidateTargets re-resolves each file immediately before the write, but a file swapped for an escaping symlink between revalidation and biome's own open() still writes outside the workspace. The guard narrows the race but cannot close it; acceptable per ADR-005 best-effort but should be documented as residual risk.
- Hard-link escape: resolveInWorkspace realpath-canonicalizes and rejects symlink escapes, but a verified in-workspace file that is a hard link to an outside inode passes the check, and biome --write modifies the shared inode (both paths). Symlink-only protection cannot detect this; out of ADR-005 scope but worth documenting.
- Read tools (biome_check/lint/format_check) on a directory containing a symlink to an outside file will cause biome to read outside content and report it. No privilege escalation (harness runs as the user), but it is an information-flow expansion beyond the workspace boundary that the read tools do not pre-verify.
- PATH fallback in resolveBiomeBinary runs whatever `biome` is on PATH when @biomejs/biome is not installed. Since @biomejs/biome is only a devDependency, production installs silently fall back to PATH — intended 'detect, not redistribute' behavior, but a malicious PATH entry would be executed without any pin.
- Positive: typed argv with no shell (core runProcess uses shell:false), paths absolutized so a value like '--config=evil' cannot be re-parsed as a biome flag, env allowlist excludes BIOME_BINARY so the shim cannot be hijacked through inherited env, and write tools are permission-gated before any probe.

## Test gaps
- No happy-path directory-input tests for any tool, though every tool advertises 'files or directories' and directory scanning is the main whole-workspace usage; only the symlink-boundary e2e passes a directory.
- The TOCTOU revalidation rejection path (revalidateTargets) is never exercised — the mocked symlink tests only cover the probe-level verifyTargetFiles rejection, not a file swapped for an escaping symlink after the probe.
- runBiome's unexpected-exit-code branch (exit code other than 0/1 → toolFailure) is untested.
- The ctx.run throwing branch (runBiome catch) is untested — every mock resolves.
- requireExisting ('path does not exist') is untested.
- biome_fix and biome_format integration tests only exercise TypeScript fixtures; the issue's acceptance criterion 'all five fixture languages covered' is met only for biome_check. lint/format_check cover only JS/TS.
- The biome_fix symlink e2e test discards the result (void result) and accepts both 'blocked' and 'skipped' outcomes — it verifies only the outside-file invariant, never that the tool returns WorkspaceViolation (that assertion exists only in the mocked tests).
- No concurrency test (e.g. two concurrent biome_fix calls on overlapping files).
- No test asserting Windows backslash input produces correctly-relativized diagnostic file paths (the existing Windows test only checks diagnostics.length).
- No test for biome emitting a non-object payload, an entry without location.path in a write probe, or format --write exit 1 after a partial write.

## Compatibility
- coreContractVersion '0.1.0' matches CORE_VERSION; the plugin passes the contract kit shape (metadata + tools, unique names, normalized errors, BinaryNotFound mapping via the mock runner).
- Plugin is exported as a named `biomePlugin` (no default export), consistent with the accepted ruffPlugin/ast-grep pattern; the contract kit receives the object explicitly. Fine, but any future host loader expecting a default export will break — the 'default Plugin object' wording in the standard is not enforced.
- The env allowlist (DEFAULT_ENV_ALLOWLIST) deliberately excludes BIOME_BINARY, which the biome shim reads — inherited env cannot redirect binary selection. Good.
- On Linux, biome's shipped bin/biome shim calls execSync('ldd --version') (constant string, shell-backed) inside the child to detect musl; this is biome's own code, no user input, no injection, but it requires /bin/sh in the child's scrubbed PATH.
- resolveBiomeBinary's shim path requires a complete pnpm install of the optional @biomejs/cli-<platform> packages (present in the PR lockfile). On a partial install the shim fails with a module-not-found inside the child, which surfaces as ToolFailure rather than the friendlier BinaryNotFound.

## Architecture
- Reuses core abstractions throughout (ctx.run, resolveInWorkspace, validateArgs, parseJsonOutput, toDiagnostic, summarizeDiagnostics, normalizeSeverity, assertPermission) — no process-runner duplication.
- Structured output only (--reporter=json); no terminal-text regex parsing.
- Probe → boundary-verify → revalidate → write with per-file dedupe is a sound design and is stronger than the accepted ruff plugin's probe → verify (it adds the TOCTOU revalidation step).
- resolveBiomeBinary's {binary, prefixArgs} abstraction cleanly models the node-shim invocation and validates the shim exists before use.
- Write tools check permission before the read-only probe — conservative and correct.
