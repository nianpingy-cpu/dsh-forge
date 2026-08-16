# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.85

## Blocking
(none)

## Non-blocking
- compat-matrix.ts buildReport: `commit` is compared raw, and upstream master always advances past the pin, so the Latest lane's `status` will be `"drift"` on essentially every scheduled run (it only reaches `"compatible"` in the test because the test passes `{...pinned}` as latest). The headline status is therefore near-useless; only the `drifts` array lets a reader see that *only* `commit` moved vs. a real requirement break. Consider a distinct status (e.g. `upstream-moved`/`compatible`) when the sole drift is the commit.
- compat-matrix.ts normalizeValue (node_requirement): space-separated compound ranges (`>=16.0.0 <19.0.0`) are truncated to the first range, so a real upstream change to `<20.0.0` would be silently missed; `||`-separated ranges with a trailing annotation let the greedy `(\s*\|\|\s*.*)?` absorb the annotation, producing perpetual spurious drift (`^18.0.0 || >=20.0.0 (upstream CI ...)` vs `^18.0.0 || >=20.0.0`). Only the simple single-range+annotation shape is tested.
- compat-matrix.ts normalizeValue (package_manager): the `[^\s(]*` tail does not strip `+sha512.<hash>` metadata that pnpm `packageManager` fields commonly carry, and it is not canonicalized across semver depth (`>=22.19` vs `>=22.19.0`). If upstream's packageManager carries a `+sha512` hash the human-annotated pinned value omits (the current manifest is `pnpm@11.7.0`), the lane reports `package_manager` drift on every run even when nothing changed.
- compat-latest.yml: the 'Always generate + upload the report' comment is false under `bash -e` semantics. If `fetch-latest-snapshot.ts` fails (gh auth/rate-limit/network) or the pinned manifest is invalid (compat-matrix exits 1), the second command and the upload step are skipped, so no report artifact is produced — the exact case where the report is most valuable. Add `continue-on-error: true` on the generate step and `if: always()` on the upload, or make the CLI exit 0 and encode the failure in the report.
- compat-latest.yml lines 30-34: the 'Fetch latest upstream master commit' step writes `steps.latest.outputs.sha`, which nothing consumes; the script re-fetches the commit. It is dead code that also adds a second failure point before the more resilient script. Remove it or feed its output into the script.
- scripts/fetch-latest-snapshot.ts / scripts/compat-matrix.ts: `execFileSync` is called without a `timeout`, and the jobs set no `timeout-minutes`. A hung `gh api` (stalled proxy, network partition) would hold a runner until GitHub's default job timeout (up to 6h). The plugin/execution rules call for a timeout on every execution.
- compat-matrix.ts main(): the report output filename is `compat-${latestCommit}.json` where `latestCommit` is used unvalidated; a missing/`null` `.sha` from a jq on an unexpected API response would produce `compat-null.json`/`compat-undefined.json` and an exit-0 'report', rather than a clean failure. The `commit` field is also silently skipped (not drift, not unobserved) when `latest.commit` is undefined, which could yield a `status: "compatible"` report with no commit observation.
- scripts/fetch-latest-snapshot.ts: `execFileSync` inherits the full runner environment rather than an allowlist (the security model calls for third-party CLIs to receive only allowlisted env vars). Low risk here since it only runs in controlled CI and gh needs GH_TOKEN, but it does not follow the stated env-allowlist principle.
- Pinned lane (ci.yml compat-pinned) 'release blocker' only checks that repository/commit are non-empty strings; it never validates that the commit exists upstream or that the manifest matches reality, so a typo'd-but-non-empty pinned commit passes the release gate. Weak gate, though it matches the stated acceptance criterion.
- compat-matrix.ts does not compare `repository` or `branch`, so a workflow typo pointing at the wrong upstream repo or a default-branch rename (master→main, which would 404 the fetch) is not reported as drift but as a hard lane failure.

## Security
- No command injection found: `execFileSync("gh", [...])` in fetch-latest-snapshot.ts builds an argv array (no shell), the workflow `run:` steps only interpolate hardcoded literals and GitHub-returned hex SHAs into `$GITHUB_OUTPUT`, and the eslint ADR-004 rule does not flag the execFileSync calls.
- No exploitable path traversal found in CI: the report filename derives from a GitHub API SHA (hex) or the repo-controlled pinned manifest; the `repo` argument is interpolated into an API route, not a filesystem path. Note as a robustness gap that a locally-crafted manifest `commit` containing path separators would influence the report output path.
- `permissions: contents: read` is set at the workflow level (least privilege) and the report/snapshot contents contain no secrets. No permission bypass found.
- Malformed CLI output is partially unvalidated: the master `commit` SHA is used raw (see non-blocking item about `null`/missing `.sha`), and the package.json fetch degrades to 'unobserved' on any error, which can mask transient failures as a clean unobserved state.

## Test gaps
- scripts/fetch-latest-snapshot.ts is entirely untested — the gh subprocess invocation, the base64 package.json decode, the degraded-to-unobserved path on failure, and the snapshot shape.
- The CLI contract of scripts/compat-matrix.ts is untested: exit code 1 on an invalid pinned manifest (the release blocker), exit 0 on drift, and the report file written to `compatibility/reports/compat-<sha>.json`.
- normalizeValue has no direct unit tests for the edge cases most likely to misfire: `||`-ranges with annotations, `+sha512` packageManager suffixes, space-separated compound ranges, prerelease tags, and semver-depth differences.
- No test covers the buildReport path where `latest.commit` is missing/undefined (silently skipped rather than unobserved), nor the realistic scheduled-lane scenario where the ONLY drift is the commit moving (status is always `drift`).
- The new scripts are not typechecked: tsconfig.json include (line 19) omits `scripts/**`, so `pnpm typecheck` never checks compat-matrix.ts/fetch-latest-snapshot.ts; only eslint (syntax-only) covers them.

## Compatibility
- package.json declares `engines.node: ">=20"` while the new scripts require Node >=22.18 (native type-stripping) and the manifest records `>=22.19`. Contributors on Node 20 running `node scripts/compat-matrix.ts` get a syntax error; the declared engines and the scripts' real requirement are inconsistent.
- The 'compatible' state is unreachable in the real Latest lane because commit always drifts (see non-blocking); the report's semantics should be documented or the status taxonomy adjusted so a genuine requirement break is distinguishable from routine upstream movement.
- The pinned manifest is consumed but not cross-validated against the pinned upstream commit (no existence check, no schema validation of node_requirement/package_manager), so the 'release blocker' provides a weak guarantee.
- Generated artifacts (`compatibility/reports/`, `compatibility/latest-snapshot.json`) are written by the new scripts but are not covered by .gitignore; the working tree already contains an untracked, stale `compatibility/reports/compat-47f94385....json` generated by an earlier script version (it predates the `unobservedFields` field). Add ignore entries and remove the stale artifact.

## Architecture
- compat-latest.yml's dead 'Fetch latest' step performs an extra `gh api` call per run and adds a second failure point before the script that does the same fetch.
- The generate step's failure handling contradicts its own 'always generate + upload' comment (see non-blocking).
- Unrelated test-timeout changes (semgrep 30s→120s, ast-grep adds 30s) are bundled into a compat-matrix PR; benign but scope creep.
- Pinned-lane validation lives in a script whose report-writing behavior is a side effect of the gate; a dedicated `validate-manifest` path (no report write) would be simpler than reusing buildReport with identical inputs.
