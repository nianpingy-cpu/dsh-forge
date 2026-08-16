# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.8

## Blocking
(none)

## Non-blocking
- {"file":"tests/docs.test.ts","summary":"The 'documents only real tools in the example guides' test only matches backtick-quoted identifiers, but all six example READMEs write the numbered Steps tool calls without backticks, so most example tool references (k6_smoke, semgrep_security_scan, video_clip, ruff_check, media_probe, quality_gate, etc.) are never validated — only the Permissions-section names are.","failure_scenario":"A future example guide typoes a tool name in its Steps section (e.g. `k6_smoke` → `k6_somke`) and CI stays green because documentedToolNames() returns nothing for unbackticked text, contradicting the test header's stated guarantee ('no invented tool names')."}
- {"file":"tests/docs.test.ts","summary":"registeredTools() imports package entry points via a computed dynamic import() of src/index.ts, which bypasses vitest's transform and depends on Node's native TS type-stripping (default only since Node 22.18). This contradicts the 'Node.js >= 20' claims in every new README and root package.json engines.","failure_scenario":"Running `pnpm test` on Node 20 (the declared minimum) throws ERR_UNKNOWN_FILE_EXTENSION for the .ts entry points; the docs test only runs on the >=22.18 toolchain the compatibility manifest already pins."}
- {"file":"packages/plugin-act/README.md","summary":"README states act runs 'with an empty HOME', but plugin-act source sets HOME (and USERPROFILE) to a fresh mkdtemp runtime directory — an empty directory, not an empty HOME value.","failure_scenario":"A reader models act invocation on the README's wording and sets HOME to the empty string, which would break act's cache/auth behavior differently from the plugin's actual temp-dir approach."}
- {"file":"packages/core/README.md","summary":"Core README lists 'Node.js >= 20' while compatibility/deepseek-harness.json pins upstream at '>=22.19'; the package READMEs' version floor is inconsistent with the pinned harness toolchain the project actually targets.","failure_scenario":"A contributor on Node 20 follows the README, then hits the docs test's type-stripping requirement or upstream harness incompatibilities that the manifest already warned about."}
- {"file":"packages/core/README.md","summary":"Core README says 'default 1 MiB output cap' while plugin-ruff README mentions a '10 MiB cap' with no explanation of the relationship, and plugin-biome/ast-grep mention '30s execution timeout' without noting the core default — caps/timeouts are described inconsistently across READMEs.","failure_scenario":"A reader cannot tell whether 10 MiB is a ruff-specific override or a documented default drift; the numbers will likely diverge further as tools are added."}
- {"file":"tests/docs.test.ts","summary":"The relative-markdown-link resolution test is currently vacuous: none of the added READMEs contain relative links (only external URLs, which are skipped), so the test exercises nothing today.","failure_scenario":"A future relative link is added and broken; the test would catch it, but the PR provides no evidence the link-checking logic actually works beyond existing external-URL skips."}

## Security
(none)

## Test gaps
- {"file":"tests/docs.test.ts","summary":"No test validates the example guides' Steps-section tool references (see non-blocking finding 1); the primary content of all six example workflows is unverified against the registered tool registry.","failure_scenario":"A Steps section references an unregistered tool and the docs gate passes."}
- {"file":"tests/docs.test.ts","summary":"The root README is never scanned: its tool lists (e.g. the trivy block), '11 core plugins' count, and '7 presets' claims are not checked against actual registration, so a stale root README can drift undetected.","failure_scenario":"A later plugin rename updates package READMEs but not the root README; the docs gate stays green."}
- {"file":"tests/docs.test.ts","summary":"The presets README test only substring-checks preset names; it does not verify each preset's plugin list matches the PRESETS definitions, nor the 'all 63 tool names' comment.","failure_scenario":"A preset's plugin composition changes in presets/presets/src/index.ts without updating the presets README table, and the gate passes."}

## Compatibility
- {"file":"tests/docs.test.ts","summary":"The docs test only works on Node >=22.18 (native TS type-stripping for its computed dynamic imports) and with pnpm workspace symlinks present, while the project's declared floor is Node >=20 — the test is compatible with the pinned DeepSeek Harness toolchain but not with the versions the READMEs advertise.","failure_scenario":"Contributor on Node 20 runs the new test and it crashes with a file-extension error rather than a meaningful failure."}

## Architecture
- {"file":"tests/docs.test.ts","summary":"registeredTools() uses a computed dynamic import() of each package's src/index.ts, bypassing vitest's module transform and executing every plugin's top-level code (and its @dsh-forge/core import) during the docs gate; this makes the docs test a de-facto load-smoke test with a Node-version-dependent failure mode.","failure_scenario":"A plugin's entry point gains a top-level side effect or a non-erasable TS feature (enum/namespace) and the docs test fails or misbehaves for reasons unrelated to documentation."}
