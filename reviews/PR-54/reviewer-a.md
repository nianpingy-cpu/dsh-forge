# Review — reviewer-a

- Verdict: **request_changes**
- Confidence: 0.85

## Blocking
- packages/core/src/index.ts:1 (and ~29 other touched .ts/.json files): every touched source and JSON file has a UTF-8 BOM (U+FEFF) prepended AND existing non-ASCII characters re-encoded through a legacy codepage. Em dashes (U+2014) become '鈥?', arrows (→) become '鈫?' across comments. This is not just cosmetic: the quality_gate summary string literal is corrupted to 'quality gate: ${verdict} 鈥?${...}' (packages/plugin-quality-gate/src/index.ts ~line 365), so the model-facing tool output now contains mojibake. Any other non-ASCII string literals / regexes in the 11 plugins (semgrep/trivy/act output markers, tool descriptions) may be silently corrupted in ways not visible in the diff. Additionally, a BOM in every package.json violates RFC 8258 and breaks tools that read them with strict JSON.parse.
- packages/plugin-act/src/index.ts ~line 545 (all 11 plugin packages): the release bumped package.json version and metadata.coreContractVersion to 0.2.0 but left the plugin metadata `version` field at "0.1.0" in every plugin (act, ast-grep, biome, docker, ffmpeg, k6, quality-gate, ruff, semgrep, trivy, uv). The harness host reads metadata.version for compatibility reasoning, so this release ships 11 plugins declaring version 0.1.0 against core contract 0.2.0. For a PR whose sole purpose is the 0.2.0 version bump, the bump is incomplete and the acceptance criterion "version 0.2.0 bump across all packages" is not met.

## Non-blocking
- presets/presets/tests/presets.test.ts:11 - describe() block label still reads 'presets (V0.1.0: coding, python, web)' after the V0.2.0 rename.
- presets/presets/src/index.ts - the new 'security' preset bundles semgrep + trivy + quality-gate, but quality_gate's lint lanes orchestrate Ruff/Biome tools, which are NOT included in the security preset (they live in 'coding'). Running quality_gate under only the 'security' preset may fail or degrade the lint lane instead of skipping it cleanly.
- PROJECT_STATUS.md:5 - 'Current Branch' still points to 'V0.1.0/issue-009-ast-grep-read-adapter (chain tip)', stale in a file this PR is editing.

## Security
- The encoding corruption is a security-relevant risk for this tool set: semgrep/trivy/quality-gate parse machine output and produce findings. If any non-ASCII string literal or matching marker inside those parsers was re-encoded the same way as the visible '鈥?' corruption, matching behavior or emitted findings could silently change (false negatives for a security scanner). The known concrete case is the quality_gate summary string, demonstrating the corruption reaches executable strings, not just comments.
- The 'security' preset can load quality_gate without the Ruff/Biome plugins its lint lanes depend on; depending on how missing-tool is classified (BinaryNotFound vs ToolFailure), the gate could return FAIL instead of skipping, making the security preset unable to certify on Python/JS projects.

## Test gaps
- No release-consistency test asserting every package.json version AND every plugin metadata.version equals CORE_VERSION — this is exactly what let the stale 0.1.0 metadata.version slip through in all 11 plugins while smoke.test.ts only checks CORE_VERSION.
- No CI/encoding guard (e.g., lint rule or script) rejecting UTF-8 BOMs and mojibake in source/JSON files; the 29-file encoding corruption went undetected by test/typecheck/lint/build.
- No test that the 'security' preset can run quality_gate end-to-end with its lint lanes resolvable or cleanly skipped when ruff/biome are absent.
- presets/presets/tests/presets.test.ts stale suite label and no assertion pinning preset -> plugin dependency coverage (e.g., that quality_gate's dependencies are present in some preset).

## Compatibility
- BOM prepended to all package.json files violates JSON spec (implementations MUST NOT add a BOM) and breaks downstream tools that read package.json with strict JSON.parse; Node/npm/pnpm tolerate it, but release/publish/registry tooling often does not.
- Plugin metadata version 0.1.0 vs coreContractVersion 0.2.0: the DeepSeek Harness host reasoning on plugin versions will see an internally inconsistent package (package.json says 0.2.0, metadata says 0.1.0).
- No changes to the DeepSeek Harness compatibility manifest in this PR despite the core contract bump to 0.2.0; the manifest still records the pinned upstream commit without noting how coreContractVersion 0.2.0 maps to it (acceptable only if the bump is purely internal).

## Architecture
- Preset composition gap: the 'security' preset's quality_gate tool depends on Ruff/Biome lane tools that are only registered via the 'coding'/'python'/'web' presets; presets are currently not validated for intra-preset tool dependencies.
- The version bump touched metadata.coreContractVersion but not metadata.version in every plugin, suggesting the bump was applied mechanically per-file rather than via a shared version source (e.g., a single constant read by all metadata objects); a shared CORE_VERSION-derived source would prevent recurrence.
