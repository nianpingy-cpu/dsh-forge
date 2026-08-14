# Review — reviewer-a (deepseek via claude cli)

- Verdict: **approve**
- Confidence: 0.72

## Blocking
(none)

## Non-blocking
- The `clean` script (`pnpm -r exec rimraf dist coverage || true`) is broken: `rimraf` is not in devDependencies, so the exec fails and `|| true` silently swallows it. `pnpm clean` is a no-op on every platform. (file="package.json", category="correctness")
- AGENTS.md instructs agents to 'verify the manifest' at `compatibility/deepseek-harness.json`, but that file is not created anywhere in this PR (not in changed files, not in deliverables). The instruction points at a nonexistent file. (file="AGENTS.md", category="documentation")
- SECURITY.md, AGENTS.md, CONTRIBUTING.md, and PROJECT_STATUS.md repeatedly cite ADR-004, ADR-005, ISSUE-006, and ISSUE-029, but none of those reference documents exist in the repository at HEAD, so the 'non-negotiable' security rules are unanchored. (file="SECURITY.md", category="documentation")
- The `verify` job has no `timeout-minutes`. A hung `pnpm install`/build step runs to GitHub's ~6 hour default; add `timeout-minutes` (e.g. 15) for resource handling. (file=".github/workflows/ci.yml", category="reliability")
- No `concurrency` group, so rapid pushes to the same PR/ref spawn redundant, competing CI runs. (file=".github/workflows/ci.yml", category="reliability")
- Actions are pinned to mutable major-version tags (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`) rather than commit SHAs; for a repo whose security posture is a stated pillar, this is a supply-chain hardening gap. (file=".github/workflows/ci.yml", category="security")
- Root version is `0.0.0` while `packages/core` is `0.1.0` and `CORE_VERSION` is `"0.1.0"`. Internally consistent for core, but the monorepo has no unified versioning story yet. (file="package.json", category="correctness")
- `main`/`types` point at `./src/index.ts`; the `dist/` output from `tsup` is only used at publish via `publishConfig`. This works for the workspace but means `pnpm build` produces artifacts nothing in-repo consumes. (file="packages/core/package.json", category="architecture")

## Security
- Bypass in the claimed 'later shell mutations' tracking: `trackOptionsMutation` only updates variables already present in `shellOpts`, and `shellOpts` is only populated from object literals that contain a `shell` key at declaration. `const opts = {}; opts.shell = true; spawn(cmd, opts);` is therefore not flagged, even though the rule's own comment claims mutation tracking. (file="eslint.config.js", category="security-rule-bypass")
- Bypass via member extraction: `bindings` is only populated from import specifiers and require destructuring, so `const exec = cp.exec; exec(cmd)` (and `const sp = cp.spawn; sp(cmd,{shell:true})`) is never resolved to a child_process name and is not reported. Same class for `.call`/`Reflect.apply`. (file="eslint.config.js", category="security-rule-bypass")
- All rule state (`bindings`, `namespaces`, `shellOpts`) is file-global and scope-blind. A same-named local in an inner scope reads/overwrites the outer entry, producing both false negatives (a real `shell: true` masked by an inner same-named `shell: false` variable, and vice-versa) and false positives (a local function named `exec` shadowing an import of `exec` gets reported). (file="eslint.config.js", category="security-rule-correctness")
- Computed-access bypasses are not covered: `cp["spa"+"wn"]`, `` cp[`spawn`] `` (TemplateLiteral property), and `{ ["shell"]: true }` (computed property key) are skipped because only non-computed Identifier properties and Literal computed properties are recognized, and `opts["shell"] = true` mutations are ignored. (file="eslint.config.js", category="security-rule-bypass")

## Test gaps
- No regression test for the `const opts = {}; opts.shell = true` mutation bypass, the namespace member-extraction bypass (`const exec = cp.exec`), or scope-shadowing interference. Each is a live bypass/false-positive not in the enumerated coverage matrix. (file="tests/eslint-adr004.test.ts", category="test-coverage")
- No test exercises `pnpm clean`; a smoke/integration test would have caught the missing `rimraf` dependency. (file="package.json", category="test-coverage")
- Coverage is explicitly not gated and the `coverage` script never runs in CI, so the v8 coverage toolchain is unverified in the only environment that matters. (file=".github/workflows/ci.yml", category="test-coverage")

## Compatibility
- `packageManager: pnpm@11.4.0` diverges from the DeepSeek Harness compatibility manifest's upstream pin (`pnpm@11.7.0 via corepack`). Reproducing the harness environment will use a different pnpm patch version. (file="package.json", category="version-mismatch")
- `engines.node >=20` and CI matrix `node: [22]` diverge from the harness requirement `>=22.19` (upstream CI covers 22.19/24/26). Worse, lockfile transitive deps raise the real floor: `eslint-visitor-keys@5.0.1` requires `^20.19 || ^22.13 || >=24` and `@napi-rs/lzma-linux-x64-gnu@1.5.1` requires `^22.20 || ^24.12 || >=25`, so `>=20` is effectively `~22.20` and CI does not cover the 24/26 runtimes the harness supports. (file="package.json", category="version-mismatch")

## Architecture
- The ~290-line hand-rolled AST security rule lives inside the ESLint config rather than a reusable plugin package, so it cannot be versioned, typed, or reused independently across plugin packages and its coverage matrix is documented only in a comment. (file="eslint.config.js", category="structure")
- The rule's name-keyed, file-global Map state (no block/function scoping) is the root cause of the cross-scope false positives/negatives; enforcing ADR-004 reliably requires ESLint code-path/scope analysis or `@typescript-eslint` scope tracking rather than a flat registry. (file="eslint.config.js", category="design")
