# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.72

## Blocking
(none)

## Non-blocking
- verified.files is not deduplicated in ruff_fix. `ruff check` emits one JSON entry per finding, so the apply argv is the file list repeated once per finding. A single file with a few hundred findings (E501/F401 in a large module) yields tens of KB of argv — beyond the ~32K-char Windows CreateProcess command-line limit and, at the 10 MiB output cap, potentially >ARG_MAX on Linux. The tool then fails with a spawn error. Deduplicate (Set) before building the apply argv.
- runRuff applies the grep-style 'exit 0/1 = success' heuristic to every subcommand, but that convention only holds for `check` and `format --check`. For `rule` and `format`, exit 1 is an error. It happens to work today (ruff exits >=2 for unknown rules and unparseable files), but it is fragile to version drift and misreports `rule` failures as ParseFailure instead of ToolFailure if a future ruff exits 1.
- ruff_format's model-facing summary reads `apply.stdout`, but `ruff format` writes its human summary ('N files reformatted, M left unchanged') to stderr, so the summary is almost always the generic 'formatted' fallback and the real counts are lost. Should parse stderr (or use --output-format json) for the summary.
- `fixable: Boolean(e.fix)` misreports on older ruff JSON that used the boolean `fixable` field instead of a `fix` object: a fixable finding is reported non-fixable. The fixture tests pass only because CI installs a recent ruff. Accepting `e.fixable === true` as well would be robust.
- toRelativeFile uses an unanchored, case-sensitive startsWith: a reported path whose string shares the workspace-root prefix (e.g. workspaceRoot `/ws`, file `/ws2/x.py`) is mislabeled as `x.py`, and a case-mismatched path on Windows/macOS stays absolute. Largely unreachable today because safePaths passes canonicalized paths upstream, but the helper itself is latent-buggy.
- resultWithDiagnostics and ruff_format slice raw stdout at 20,000 chars mid-stream, which can cut a JSON array token or split a UTF-16 surrogate pair. Impact is cosmetic (raw is reference-only) but the truncation marker can land inside a code point.
- Timeout message hardcodes 'exceeded the 30000ms execution timeout' while the runner's default is applied via timeoutMs; the message is stale if the cap is ever parameterized.
- The contract-kit change defaults `permission: {approved: true}`, a shared behavioral change for every plugin (workspace-write tools now execute for real inside the kit). It is justified, but the kit's valid-args run for ruff_fix mutates the temp fixture (removes the F401s in fixtures/sample.py); the suite only passes because plugin.tools order runs ruff_check before ruff_fix. Brittle coupling between kit execution and fixture mutation.
- The write-path TOCTOU is substantially mitigated: verifyTargetFiles stores the canonicalized (realpath) target from resolveInWorkspace, so a symlink redirection of the original path between probe and apply cannot redirect the write. The residual race (the canonical target path itself is swapped for a symlink between verify and apply) is the general path-based TOCTOU inherent to all subprocess write tools and matches the accepted ast-grep pattern; worth a comment documenting it.

## Security
- Residual write-path TOCTOU: between the boundary-verified probe and the apply, a verified canonical file can be replaced by a symlink to an outside target; ruff follows it at apply time and writes outside the workspace. Window is milliseconds and needs concurrent filesystem mutation, and using canonical paths closes the symlink-redirect case, but the apply does not re-verify the file identity immediately before writing.
- resolveRuffBinary trusts PATH order and returns the first `ruff`/`ruff.exe` hit without verifying it is the intended tool (no hash/version check). A shadowed or malicious binary earlier on PATH would be executed. This is inherent to the 'binary detection, not redistribution' model and the core runner's env allowlist still applies, but it is worth noting as the plugin's execution trust anchor.

## Test gaps
- Issue-required per-tool TDD cases are uneven: ruff_format_check has no malformed-JSON, BinaryNotFound, or Windows-path tests; ruff_explain lacks malformed-JSON and BinaryNotFound; ruff_fix and ruff_format lack BinaryNotFound, malformed-JSON, Windows-path, and a no-op-probe test that asserts the apply runner is never invoked when the probe yields zero files (the mock `applied` flag pattern exists but is only used for the escape case).
- No test exercises the apply-argv scale/dedupe failure (many findings per file / many files on Windows) — the exact failure mode of the top non-blocking finding.
- The contract kit simulates BinaryNotFound only for ruff_check (the designated probe); ruff_fix/ruff_format/ruff_explain share runRuff but their BinaryNotFound path is never directly exercised.
- Timeout and truncated-output paths are only tested for ruff_check; no test forces timedOut/truncated on fix/format/explain.
- No integration test verifies `select`/`ignore` are passed through to the real CLI, or that a rule selector containing special characters (e.g. spaces, semicolons) is safely handled as a single argv element.
- `fixable`/`rule` assertions (rule === 'unformatted', fixable === true) are version-fragile and will fail on older ruff builds; no test matrix over ruff versions.

## Compatibility
- CI installs ruff unpinned (`python -m pip install --break-system-packages ruff`). The plugin and tests depend on version-specific JSON shapes (`format --check` 'code'/'unformatted' field, `fix` object vs `fixable` boolean, `rule --output-format json` support), so tests will flake as ruff evolves. Pin a version (and consider a cache key).
- `pnpm test` now hard-requires a local ruff install; the repository does not document this prerequisite for contributors.
- metadata.upstreamTool: 'Ruff' omits the tested-against version that the plugin standard requires ('upstream tool + version tested against').
- The permission hook API is still 'TBD' in the DeepSeek Harness compatibility manifest; this plugin assumes `ctx.permission = { approved: boolean }`. Consistent with the existing ast-grep plugin, but the integration surface against the pinned upstream commit is unverified (per the manifest's own note).

## Architecture
- metadata.coreContractVersion is hardcoded to '0.1.0' rather than derived from CORE_VERSION; the contract kit catches drift only at test time, so the hardcode risks silent version skew in production.
- The contract-kit `permission: { approved: true }` default is a cross-plugin semantic change: write tools of all plugins now execute for real in the kit, and denial coverage is pushed entirely onto per-plugin tests. Acceptable, but it should be called out in the kit docs and considered when auditing ast-grep.
- The apply-for-write strategy (probe → boundary-verify → apply on verified list) is a good reuse of the established ADR-005 pattern, but it duplicates the probe+apply orchestration logic inside each write tool; a shared core helper (probeAndApply) would prevent the two write tools drifting (they already differ subtly in exit-code handling and argv construction).
