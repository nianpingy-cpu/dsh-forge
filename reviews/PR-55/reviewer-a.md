# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.92

## Blocking
(none)

## Non-blocking
- presets/presets/tests/presets.test.ts:10 — describe() label still reads 'presets (V0.1.0: coding, python, web)' while the suite now asserts the full V0.2.0 7-preset set including media/full. Already flagged in the PR-54 review and still unaddressed; rename to reflect the current scope.
- presets/presets/src/index.ts:33 — the `full` preset is a hand-maintained static list, and nothing mechanically enforces its 'every plugin' claim (README.md:62, description at index.ts:86-87). Adding a 12th plugin to the workspace without updating `full` silently breaks the contract; the test suite would still pass.
- Duplicate-registration semantics only hold within a single preset. `Preset.plugins` docstring says 'no duplicate plugin/tool registrations' (index.ts:23) and `validatePreset` enforces it per-preset, but the documented load model is 'load a preset' (singular). A host that ever registers `full` plus a focused preset (e.g., security) would double-register every plugin/tool. Pre-existing design, made more prominent by `full`; should be stated as the loading contract.
- The media/full presets now pull 8 FFmpeg workspace-write tools, Docker compose up/down, act run, k6 run, and trivy image scan into a single default preset. Each tool still requires its own DSH permission approval (mutationClass gates unchanged), so no bypass — but operators loading `full` should expect a broad approval surface.

## Security
- No new security surface: the diff is pure composition of existing plugin objects; no subprocess execution, filesystem mutation, or network access is introduced. ADR-004 compliance of the underlying tools was established in their own PRs (e.g., plugin-ffmpeg PR-50).

## Test gaps
- No test asserts `full` is the union of every @dsh-forge/plugin-* package in the workspace. The 'every plugin' claim (README.md:62, index.ts:86-87) can silently drift when a new plugin ships without updating the `full` array.
- media/full are only exercised through `resolvePreset`; `resolvePresetOrThrow`/`validatePreset` is never called with a valid media/full preset, so the validation success path for the new presets is untested through the throwing API (the loop test at presets.test.ts:24 covers contract version and within-plugin tool uniqueness directly).
- No regression test that every plugin referenced by a preset is declared as a dependency of presets/presets/package.json (flagged in PR-54). This PR satisfies it for ffmpeg, but a future preset reference would fail only at import time.
- `validatePreset` error paths — duplicate plugin registration, non-@dsh-forge/plugin-* name, coreContractVersion mismatch, non-array tools — have no direct unit tests (pre-existing, not introduced here).

## Compatibility
- All 11 plugins referenced by media/full declare coreContractVersion '0.2.0' == CORE_VERSION; plugin package + metadata versions are aligned at 0.2.0.
- pnpm-lock.yaml is consistent: plugin-ffmpeg has its own importer entry and the presets importer entry is added; presets/presets/package.json declares the new dependency.
- No public API change: PRESETS, resolvePreset, resolvePresetOrThrow, presetToolNames, validatePreset all preserve their signatures; the change is purely additive.
- Cross-platform: pure static composition, no platform-specific code; loading `full` does not require the ffmpeg binary to be present (binary detection is runtime, per the no-redistribution rule).

## Architecture
- `full` as a static hand-maintained list duplicates knowledge of the workspace plugin set; deriving it from a registry (or a completeness test) would remove the drift risk noted above.
- plugin-ffmpeg/src/index.ts:19 carries a stale '(RED — the tools below are not implemented yet; tests are failing.)' comment above a fully implemented tool set. Outside this diff, but it now sits directly behind the new media/full presets and will mislead readers.
