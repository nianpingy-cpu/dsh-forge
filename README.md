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

**Early development.** Not published yet. See [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Principles

1. **No arbitrary shell execution.** Every tool takes typed arguments, validated and compiled to `argv[]`. `shell: true` is forbidden.
2. **Workspace boundary.** Write operations must stay inside the workspace. Path traversal is rejected by default.
3. **Structured results.** CLI output is normalized into `Diagnostic[]` and compressed summaries — never raw walls of text.
4. **Explicit permissions.** Every tool declares a `MutationClass` (`read`, `workspace-write`, `network`, `process`, `system-change`, `destructive`) and honors the DSH permission system.
5. **Upstream compatibility is pinned.** See `compatibility/deepseek-harness.json`.

## Planned plugins

ast-grep · Ruff · Biome · uv · act · Semgrep · Trivy · Docker · k6 · FFmpeg

## License

MIT
