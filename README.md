# dsh-forge

Developer tool plugin ecosystem for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

dsh-forge turns mature developer CLIs into typed, safe, structured DeepSeek Harness tools:

```
DeepSeek Harness
      ↓
Typed Tool
      ↓
Safe Adapter
      ↓
Structured Execution
      ↓
Normalized Result
      ↓
Agent Reasoning
      ↓
Fix / Retry / Verify
```

## Status

**V0.2.0** — published (tag `v0.2.0`). See [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Principles

1. **No arbitrary shell execution.** Every tool takes typed arguments, validated and compiled to `argv[]`. `shell: true` is forbidden.
2. **Workspace boundary.** Write operations must stay inside the workspace. Path traversal is rejected by default.
3. **Structured results.** CLI output is normalized into `Diagnostic[]` and compressed summaries — never raw walls of text.
4. **Explicit permissions.** Every tool declares a `MutationClass` (`read`, `workspace-write`, `network`, `process`, `system-change`, `destructive`) and honors the DSH permission system.
5. **Upstream compatibility is pinned.** See `compatibility/deepseek-harness.json`.

## Plugins

Implemented (all with typed tools, contract suite, live integration tests):

| Plugin | Package | Tools |
| --- | --- | --- |
| ast-grep | `@dsh-forge/plugin-ast-grep` | search, scan, rewrite |
| Ruff | `@dsh-forge/plugin-ruff` | check, format-check, explain, fix, format |
| Biome | `@dsh-forge/plugin-biome` | check, lint, format-check, fix, format |
| uv | `@dsh-forge/plugin-uv` | run, sync, add, remove, tree |
| act | `@dsh-forge/plugin-act` | list, run, status |
| Semgrep | `@dsh-forge/plugin-semgrep` | scan |
| Trivy | `@dsh-forge/plugin-trivy` | fs, image, sbom, config, version |
| Docker | `@dsh-forge/plugin-docker` | ps, images, logs, inspect, version, compose + stateful run/exec |
| k6 | `@dsh-forge/plugin-k6` | version, run, smoke, load, stress, summary, threshold-check |
| FFmpeg | `@dsh-forge/plugin-ffmpeg` | probe, clip, transcode, concat, audio-extract, audio-convert, thumbnail, compress |

## Presets

`@dsh-forge/presets` composes plugins into ready-made bundles (configuration only — no plugin code duplication):

- `coding` — ast-grep + Ruff + Biome
- `python` — Ruff + uv
- `web` — Biome + ast-grep
- `security` — Semgrep + Trivy + quality-gate
- `devops` — act + Docker + k6

Presets resolve to registered plugins and are validated against the current core contract (`CORE_VERSION`); unknown presets and duplicate registrations fail loudly.

## E2E

`tests/e2e/` ships a minimal host shim (`host.ts`) plus two suites:

- **Deterministic no-API integration** — loads a real plugin, registers its tools, routes a typed call through the core contract, and asserts the canonical structured result (no model API).
- **Host-shim E2E (deterministic)** — loads a preset, registers every tool, and routes a typed call to a structured result.

> **Blocked sub-task (V0.1.0):** real DeepSeek Harness integration (Cordis
> plugin loading, host/client aggregation, DSH permission hook) is **explicitly
> blocked** — the pinned compatibility manifest (`compatibility/deepseek-harness.json`)
> lists the DSH permission-hook API as TBD, so no real-harness assertions can
> be made yet. npm-publish is likewise a blocked sub-task (release is a
> GitHub Release + tag). Per ISSUE-013's exit criteria, deferred sub-tasks are
> marked blocked with everything else green.

## License

MIT
