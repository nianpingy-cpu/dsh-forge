# Review — reviewer-a (deepseek via claude cli)

- Verdict: **request_changes**
- Confidence: 0.85

## Blocking
- {"file":"eslint.config.js","line":22,"summary":"The ADR-004 'no shell' ESLint rule is dead code: the selector requires a NewExpression, but child_process.spawn is always a CallExpression, and it inspects arguments.1 (.value.shell) while the options object is arguments[2] — and ObjectExpression nodes have no .value property. The standard spawn(cmd, args, {shell:true}) form is never matched.","failure_scenario":"A plugin writes `import { spawn } from 'node:child_process'; spawn('sh', ['-c', userInput], { shell: true })` — `pnpm lint` passes because the selector NewExpression[callee.name='spawn'] cannot match a CallExpression and arguments[1] is an ArrayExpression whose .value is undefined. The repo's core security guarantee ('shell: true is forbidden, enforced by ESLint' per AGENTS.md/SECURITY.md/ADR-004) is not enforced at all."}

## Non-blocking
- {"file":"eslint.config.js","line":22,"summary":"Even if the selector were fixed to CallExpression, it only covers `spawn` invoked with an inline object literal. exec, execSync, spawnSync, fork, and child_process.spawn via MemberExpression are uncovered, and options built from a variable (`const o = {shell:true}; spawn(cmd,args,o)`) escape the check."}
- {"file":"package.json","line":13,"summary":"engines.node is '>=20' but the pinned dependency tree requires newer: eslint-visitor-keys@5.0.1 needs ^20.19.0||^22.13.0||>=24 and @napi-rs/lzma needs ^22.20. CI only tests node 22, so the declared minimum is both unverified and likely false."}
- {"file":"package.json","line":11,"summary":"packageManager pins pnpm@11.4.0 while the DeepSeek Harness compatibility manifest pins upstream at pnpm@11.7.0 (corepack). CI uses pnpm/action-setup@v4 which honors the 11.4.0 field, diverging from the upstream toolchain the manifest declares."}
- {"file":"package.json","line":31,"summary":"`clean` runs `pnpm -r exec rimraf dist coverage || true`, but rimraf is not a dependency anywhere, so the command always fails and the `|| true` silently swallows it — clean is a no-op that reports success and does nothing."}
- {"file":".github/workflows/ci.yml","line":45,"summary":"CI lacks timeout-minutes and concurrency cancellation, so a hung test can consume a runner for the full 6-hour default, and superseded runs are not canceled. It also does not run `format:check` and has no coverage gate (coverage 'not gated yet' is stated but CI doesn't even emit it)."}
- {"file":".github/workflows/ci.yml","line":12,"summary":"Matrix only tests node 22, while the upstream harness CI covers 22.19, 24, and 26 and requires >=22.19; the declared '>=20' engine is never exercised."}
- {"file":"packages/core/package.json","line":7,"summary":"main/types point at ./src/index.ts with publishConfig overriding to dist, but there is no `exports` map and no `files` allowlist. Plain-Node ESM consumers outside Vitest resolve the .ts source and fail at runtime (no type stripping on Node 20); publishing would also include src/."}
- {"file":"PROJECT_STATUS.md","line":7,"summary":"PROJECT_STATUS.md hardcodes 'Current PR: #31 (ISSUE-001)' and 'Blocked: PR #31', but the repository's recent commits all reference #31 for the ISSUE-009 shell-rule work — the numbering collides and a PR should not hardcode its own number/blocked status before merge."}
- {"file":"SECURITY.md","line":11,"summary":"SECURITY.md, AGENTS.md, and CONTRIBUTING.md reference ADR-004/ADR-005 and ISSUE-006 as binding enforcement points, but no ADR or docs/ files exist in this PR — the enforcement story is aspirational and unverifiable at merge time."}
- {"file":"package.json","line":1,"summary":"No .gitignore is added anywhere in the PR. The first `pnpm install` leaves node_modules/ untracked, and despite AGENTS.md's 'never commit .env/secrets' rule there is no mechanism preventing accidental commits of node_modules, coverage/, dist/, or .env."}
- {"file":"package.json","line":1,"summary":"The issue objective explicitly lists LICENSE, but no LICENSE file is created (package.json declares MIT only). The repo is not actually MIT-licensed on disk."}

## Security
- {"file":"eslint.config.js","line":22,"summary":"The only automated enforcement of ADR-004 (no shell:true) is a malformed AST selector that can never fire on real spawn() calls — the security model's central control is non-functional."}
- {"file":"package.json","line":1,"summary":"No .gitignore means node_modules/, .env, and secrets have no first-line defense against being committed, contradicting AGENTS.md's own security rule."}
- {"file":".github/workflows/ci.yml","line":1,"summary":"CI does not run a test that proves the ADR-004 lint rule flags shell usage, so a regression (or the current broken state) ships with all gates green."}

## Test gaps
- {"file":"eslint.config.js","line":22,"summary":"No test exercises the no-shell rule. Recent commits claim a 'real AST visitor' was shipped, but the config still contains the dead NewExpression selector; a negative/positive lint fixture test would have caught this."}
- {"file":".github/workflows/ci.yml","line":30,"summary":"No CI check runs `format:check`, so prettier drift is undetected even though `format` is a root script."}
- {"file":"package.json","line":31,"summary":"`pnpm clean` is untested and broken (rimraf missing); no build-output smoke test verifies the tsup dist artifacts actually import in Node."}
- {"file":"tsconfig.json","line":1,"summary":"tsconfig.json and vitest.config.ts were not shown in the diff, so strict-mode / include coverage of tests and packages/core cannot be verified; engine '>=20' is never exercised by the node-22-only matrix."}

## Compatibility
- {"file":"package.json","line":13,"summary":"Node engine declared >=20 conflicts with the manifest's upstream requirement >=22.19 and with deps in the lockfile requiring >=22.13/22.20."}
- {"file":"package.json","line":11,"summary":"pnpm pinned at 11.4.0 diverges from the manifest's upstream corepack pin pnpm@11.7.0."}
- {"file":".github/workflows/ci.yml","line":12,"summary":"CI matrix [ubuntu, windows] x node 22 omits the 24/26 versions upstream CI covers; no OS/Node combination matches the declared engines floor."}

## Architecture
- {"file":"eslint.config.js","line":22,"summary":"AST-selector-based shell enforcement is structurally unreliable: wrong node type, wrong argument index, and dependence on inline object literals. A purpose-built no-shell rule (or typescript-eslint rule with proper visitor) is needed, with fixtures."}
- {"file":"packages/core/package.json","line":7,"summary":"Dual main (src for dev, dist for publish) without an exports map is fragile for ESM consumers and makes the 'resolve and export CORE_VERSION' smoke test validate Vitest resolution rather than the built artifact."}
