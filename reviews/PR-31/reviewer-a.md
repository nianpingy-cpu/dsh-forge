# Review — reviewer-a (deepseek via claude cli)

- Verdict: **request_changes**
- Confidence: 0.82

## Blocking
- {"file":"eslint.config.js","line":145,"summary":"ADR-004 no-shell lint rule remains bypassable in four untested forms despite claiming to catch 'bypass forms': inline require/createRequire call chains, computed non-literal member access, options-object mutation after declaration, and shell obtained via object spread.","short_summary":"no-shell rule bypassable via 4 untested forms","failure_scenario":"A plugin author writes `createRequire(import.meta.url)(\"node:child_process\").execSync(userInput)` (callee object is a CallExpression, so resolveChildProcessName at eslint.config.js:145 returns undefined and the call is never reported), or `const o={shell:false}; o.shell=true; spawn(\"sh\",[\"-c\",cmd],o)` (the shellOpts map was populated from the initializer; the later assignment is invisible), or `const base={shell:true}; spawn(\"sh\",[\"-c\",cmd],{...base})` (the check loop only inspects explicit Property nodes and Identifier args). `pnpm lint` stays green, the shell-executing plugin ships, and CI offers no signal. The test suite in tests/eslint-adr004.test.ts covers only the bound/literal forms, so these regressions are not exercised.","category":"security","verdict":"CONFIRMED"}

## Non-blocking
- CI never runs `format:check` (prettier installed and scripted but not enforced), despite 'format' being an explicit objective of ISSUE-001; a formatting regression can merge silently.
- Coverage is configured (@vitest/coverage-v8, vitest.config.ts) but not gated or even run in CI; the issue objective lists 'coverage'. At minimum a CI `pnpm coverage` step is expected.
- `pnpm clean` is broken: `rimraf` is not declared anywhere; `pnpm -r exec rimraf dist coverage` fails and is silently swallowed by `|| true`.
- Root engines declares `node >=20` but CI only tests node 22; several transitive deps (e.g. eslint-visitor-keys@5.0.1) require `^20.19 || ^22.13 || >=24`, so the declared support range is not actually verified.
- packages/core `main`/`types` point to `./src/index.ts`; a raw Node consumer (no vitest/tsup) cannot import the package without a TS loader. publishConfig only fixes the published state, so workspace/runtime consumers break. The `pnpm build` output (dist/) is referenced by nothing.
- AGENTS.md references `compatibility/deepseek-harness.json` and ADR-004/005 documents that do not exist at this PR's head — dangling references that mislead contributors until later commits land.
- CI workflow has no `timeout-minutes` and no `concurrency` group; a hung step runs to GitHub's default limit and back-to-back pushes can queue duplicate full runs.
- pnpm-workspace.yaml uses `allowBuilds: esbuild: true`; verify this is a recognized key for the pinned pnpm 11.4.0 — if ignored, esbuild's build script is silently not approved and works today only because esbuild ships prebuilt platform binaries.
- The rule docstring overclaims coverage ('bypass forms are caught'); with the known gaps above this gives future reviewers false assurance about the repo's primary ADR-004 gate.
- eslint rule has no scope analysis: a file that imports `exec` from child_process AND shadows it with a local `exec` will be falsely flagged (and conversely the untracked forms are missed).

## Security
- BLOCKING (see blocking[0]): inline require/createRequire call chains, computed non-literal member access, options mutation, and shell-from-spread all evade the ADR-004 rule.
- Direct shell-binary invocation `spawn("sh"/"bash", ["-c", cmd])` is arbitrary shell execution equivalent to shell:true but is outside the rule's model entirely; either ADR-004's scope should be documented to exclude it, or binary-name detection should be added.
- The rule is the sole automated enforcement of the repo's 'non-negotiable' no-shell invariant; its remaining holes mean plugin code can merge with shell execution and all gates stay green.

## Test gaps
- No regression tests for the four remaining bypass forms: inline `createRequire(...)("node:child_process").execSync(...)`, `require("node:child_process").exec(...)`, computed non-literal `cp[fn](...)`, and `opts.shell = true` post-mutation / shell-from-spread.
- No test that `spawn("bash", ["-c", ...])` is deliberately out of scope (or that it is caught) — the ADR-004 boundary is undefined and untested.
- No test for shadowing: file imports `exec` from child_process and defines a local `exec` — the rule will false-positive; behavior is unspecified.
- Smoke test only asserts the CORE_VERSION string; nothing exercises the `pnpm build` artifact (dist/) or verifies the published entry points.

## Compatibility
- Node matrix is only `[22]` on ubuntu+windows while engines says >=20 and the pinned upstream harness manifest requires >=22.19 (covers 22.19/24/26) — expand the matrix or narrow engines.
- packageManager pnpm@11.4.0 vs upstream harness pin pnpm@11.7.0 — acceptable for a standalone repo but should be a deliberate decision, not silent drift.
- `allowBuilds` key validity for pnpm 11.4.0 is unverified (see non_blocking).

## Architecture
- ADR-004 enforcement rests on a hand-rolled ~200-line binding-tracking ESLint rule embedded in eslint.config.js with no scope analysis; the primary control should remain the contract test kit + external review (rule is a backstop), and its documented claims should be corrected to match reality.
- Dependencies declared with `workspace:*` for @dsh-forge/core at the root while also being a workspace package is workable but couples the root toolchain to the runtime package; consider whether the smoke test should target the built artifact.
