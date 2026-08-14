# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.75

## Blocking
(none)

## Non-blocking
- runSg treats ANY non-zero exit with stdout starting '[' or '{' as success (packages/plugin-ast-grep/src/index.ts). This makes no-match (sg run exit 1, stdout '[]') work, but it will also swallow genuine sg errors that emit leading-JSON on stdout, and it depends entirely on sg always printing a JSON array (even empty) to stdout. Fragile malformed-output heuristic; works for the tested flows.
- Core's 1 MiB stdout cap is ignored: `execution.truncated` is never checked, so a large-but-valid scan (stdout truncated by runProcess) yields `ParseFailure` from a partial JSON parse instead of a usable partial result. Same class of problem as the raw-field caps, but for the diagnostics path.
- Diagnostics arrays are unbounded: a scan over a large tree materializes every finding into a Diagnostic[] (bounded only upstream by the 1 MiB raw cap, still tens of thousands of objects). No cap or streaming; summarizeDiagnostics only limits the model-facing summary.
- ast_scan maps `f.message` for the diagnostic text, but ast-grep scan findings carry `note`/`text`, so diagnostics will almost always render the placeholder "scan finding" and discard the actual finding content. The test only asserts rule/severity/file, so this is unexercised.
- ast_scan / ast_rule_test ToolFailure messages can leak the OS temp path (`dsh-sg-rule-<random>/rule.yml`) into model-facing output because sg error text is returned verbatim.
- ast_search / ast_inspect accept `paths: []` (schema requires the key, not a non-empty array), which makes `sg run` scan the entire workspace while the summary reports "in 0 path(s)".
- safePaths rethrows any non-WorkspaceViolationError from resolveInWorkspace (e.g. missing/non-realpathable workspaceRoot), so the tool throws instead of returning a normalized ToolResult in that edge.
- toRelativeFile relies on exact string prefix match; on Windows a case or separator mismatch between sg output (`C:/...`) and workspaceRoot (`C:\...`) leaves absolute paths in diagnostics instead of workspace-relative ones.
- ast_inspect is functionally identical to ast_search (same argv construction, same `sg run --json=pretty` output) with only a different summary and a 40k raw cap; the "detailed match info" it promises is just the unparsed raw JSON.
- `resolveSgBinary() ?? "sg"` is dead-nullish: resolveSgBinary never returns undefined, so the BinaryNotFound message always names `sg` even when a resolved package binary failed to spawn.

## Security
- withRuleFile writes model-supplied rule YAML to the OS temp dir and then spawns a subprocess while the tool declares `mutationClass: "read"` ("no side effects outside the process"). It is benign today (mkdtemp 0700, removed in finally) but is a filesystem side effect outside the workspace under a no-gate read class; any future enforcement of "read ⇒ no fs writes" breaks these tools, and a hostile local user with temp-dir access could observe rule content.
- resolveSgBinary's PATH-candidate loop uses `require.resolve("sg")` / `require.resolve("ast-grep")`, which is Node *module* resolution, not PATH lookup. If any npm package named `sg` or `ast-grep` is present in node_modules, existsSync returns true on its JS `main` entry and the plugin spawns a JS file as a binary, producing SpawnFailure (EINVAL/ENOEXEC) instead of the BinaryNotFound contract the hint promises.
- Captured output (raw + diagnostics) is never passed through core runProcess's `redact`; matched source snippets containing secrets (e.g. API keys in scanned code) surface in model-facing output. ToolContext carries no secret source, so the plugin cannot redact — a platform gap the plugin silently inherits.

## Test gaps
- No test for malformed CLI output with exit 0 (non-JSON on stdout) → ParseFailure, or for a genuine sg error to stderr → ToolFailure (stderr first-line extraction is untested).
- No structural assertion on ast_scan diagnostics beyond rule/severity/file: message content (currently the "scan finding" placeholder) and line/column mapping are never verified.
- No test for the truncated-stdout path (core 1 MiB cap); current behavior (ParseFailure) is not exercised or documented.
- No test for ast_scan with rule omitted and no sgconfig.yml (ToolFailure) or with an actual project sgconfig.yml.
- resolveSgBinary test only asserts truthiness — a value that is always "sg" — so neither the @ast-grep/cli branch nor the PATH fallback is actually validated.
- No test for temp-file cleanup on error paths, concurrent ast_scan/ast_rule_test invocations, or symlinked workspace paths.

## Compatibility
- @ast-grep/cli is a devDependency only. When the plugin is consumed as a dependency, require.resolve("@ast-grep/cli/package.json") fails and resolution depends on a bare `sg` on PATH; on Windows a PATH-only npm-global install exposes `sg.cmd` shims that spawn(..., shell:false) cannot reliably execute (core maps that EINVAL to SpawnFailure, not BinaryNotFound).
- Binary discovery depends on @ast-grep/cli's postinstall copying the platform binary to the package root; this PR adds `allowBuilds: '@ast-grep/cli': true`, but any environment with pnpm build-scripts disabled (a common security posture) makes the contract suite's non-probe tools fail.
- `main`/`types` point at `./src/index.ts` — a source-only package. Works under the pnpm workspace + vitest, but a plain Node host loading the plugin directly fails without a TS loader.
- The plugin declares no peerDependencies/optionalDependencies for @ast-grep/cli, so consumers get no package-manager-level signal that the upstream binary package is required.

## Architecture
- Temp-file rule persistence (withRuleFile) is bespoke plugin infrastructure; a core primitive (or stdin-rule support) would avoid per-plugin temp-file code and the read-class contradiction.
- ast_inspect duplicates ast_search's argv construction and result handling; a shared internal helper would remove duplication and format-drift risk.
- The require.resolve PATH-candidate loop in binary.ts is effectively dead code with a pathological false-positive path; either implement real PATH lookup or drop the loop and rely on spawn's PATH resolution.
- `export { fileURLToPath }` from binary.ts re-exports a Node builtin with no in-repo consumer — public-surface pollution.
- The PR diff mixes unrelated chain commits (eslint no-shell rule rewrite, review scripts/artifacts for PR #31..#36, docs) with the ISSUE-009 work, making the review surface noisy; the bundled eslint rule still carries the recorded PR-31 bypasses, which are not addressed here.
