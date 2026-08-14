# Review — reviewer-a (deepseek via claude cli)

- Verdict: **request_changes**
- Confidence: 0.8

## Blocking
- eslint.config.js no-shell-exec is still bypassable in ways its own docstring claims are caught, and tests/eslint-adr004.test.ts does not cover them: (1) `const cp = require('node:child_process'); cp.exec(cmd)` — trackBinding only handles ObjectPattern require, so a plain Identifier require binding is never registered; (2) computed member access `cp['exec'](...)` / `cp['spawn'](...)` — resolveChildProcessName returns undefined because of the `!callee.computed` guard; (3) `const opts = { shell: true }; spawn(cmd, args, opts)` — the rule only scans inline ObjectExpression args, so a variable-held options object with shell:true evades detection; (4) createRequire is not tracked at all (`const req = createRequire(import.meta.url); req('node:child_process')`), so even destructured exec via createRequire is missed. Since AGENTS.md/SECURITY.md state shell execution is 'forbidden (ADR-004)' and 'enforced by ESLint', the PR's security deliverable is incomplete; the docstring comment ('member-expression / aliased-import bypasses are caught') is factually wrong.
- TDD/acceptance mismatch: the issue's TDD RED requires a failing smoke test committed before the implementation, but the PR's only test evidence is the post-hoc GREEN smoke test asserting CORE_VERSION. There is no RED commit referenced in the head history and no assertion that the RED step actually failed for the right reason; the smoke test only proves resolution/export, not that the required failing-first cycle was performed.

## Non-blocking
- AGENTS.md (binding rules) instructs agents to verify `compatibility/deepseek-harness.json` before touching integration code, but that file is not part of this PR (committed separately in PR #2). At this commit the reference is dangling.
- `pnpm clean` runs `pnpm -r exec rimraf dist coverage || true`; rimraf is not declared anywhere and is absent from pnpm-lock.yaml, so the command fails in every package and `|| true` masks it — `pnpm clean` silently does nothing on a fresh install.
- engines declares node >=20 and CONTRIBUTING.md says Node >=20, but the DeepSeek Harness compatibility manifest requires >=22.19; CI only exercises node 22, so node 20-21 are advertised but below the harness floor and untested.
- packageManager pins pnpm@11.4.0 while the compatibility manifest records the upstream pin as pnpm@11.7.0; version skew with upstream should be reconciled or justified.
- CI jobs have no timeout-minutes (GitHub default is 360 min); a hung step can block CI for hours. Add per-job timeouts.
- packages/core package.json description advertises 'process runner, diagnostics, workspace policy, contract test kit' but ships only CORE_VERSION, and it has no `exports` map — so the future `@dsh-forge/core/testing` deep import referenced by the plugin standard cannot resolve. Trim the description or add the exports surface.
- pnpm-workspace.yaml declares a `presets/*` glob with no matching directory in this PR (dead config).
- Version skew: root 0.0.0 vs core 0.1.0 / CORE_VERSION '0.1.0' — acceptable pre-release but worth an explicit policy.
- The no-shell rule scans every object argument for a `shell` key, so in TS source `shell: false as const` (a TSAsExpression) would be falsely flagged as unsafe while legitimate variable-hoisted options evade it; consider handling TS wrapped literals.

## Security
- ADR-004 enforcement gaps in eslint.config.js (see blocking #1): require-as-Identifier, computed member access, variable-held options, and createRequire are all undetected, so the ESLint gate the security policy depends on can be bypassed without any lint error.
- SECURITY.md states 'No arbitrary shell execution ... shell: true is forbidden (ADR-004)' — this claim is only as strong as the lint rule, which the above cases defeat.
- No actual shell-invoking code exists in this PR, so the gaps are latent guardrail weaknesses, not exploitable vulnerabilities today.

## Test gaps
- tests/eslint-adr004.test.ts covers import/namespace/alias/require-destructure but has no cases for: `const cp = require('node:child_process')` + `cp.exec`, computed member access `cp['exec']`, a variable-held options object with shell:true, or createRequire-based access — the exact bypass classes this rule was written to close.
- Smoke test asserts only CORE_VERSION; nothing verifies the CI contract (frozen-lockfile install, typecheck, lint, build) reproduces from a clean checkout, so a broken `pnpm clean`/rimraf or a NodeNext resolution regression would pass unnoticed.
- No test exercises the required TDD RED phase (failing smoke test before core existed); the issue's 'Required Tests' only cover the GREEN end state.
- Cross-platform gap: no CI step or test validates `pnpm clean` (which would surface the undeclared rimraf on both ubuntu and windows).

## Compatibility
- Node engine floor (>=20) is below the pinned DeepSeek Harness requirement (>=22.19); root package.json and CONTRIBUTING.md should match the manifest.
- pnpm pinned at 11.4.0 vs manifest upstream pin 11.7.0 — verify lockfile behavior against the pinned upstream before claiming harness compatibility.
- CI matrix tests only node 22; the manifest notes upstream CI covers 22.19, 24, and 26 — add at least one additional major to catch version drift.
- AGENTS.md/SECURITY.md reference harness integration contracts (permission hook API 'TBD', ISSUE-006/010) that are unverified against the pinned commit; the manifest itself marks these TBD, so claims in these docs should not be read as confirmed compatibility.

## Architecture
- ADR-004 enforcement lives only in the root eslint.config.js; per the Plugin Standard, every plugin package should inherit this gate, so the rule (and its regression tests) belong in the shared @dsh-forge/core contract test kit so plugin packages can't skip it.
- AGENTS.md references a compatibility manifest that this PR does not commit, creating a chicken-and-egg for agents following its binding rules; commit the manifest or point to the separate PR.
- packages/core advertises a runtime surface (process runner, diagnostics, workspace policy, contract test kit) that is not implemented, and has no exports map to later add `@dsh-forge/core/testing`; the metadata should reflect the currently shipped surface.
- Root devDependency on `@dsh-forge/core` (workspace:*) is only needed for the root smoke test — acceptable, but consider moving the smoke test into packages/core/tests to keep the root dependency graph minimal.
