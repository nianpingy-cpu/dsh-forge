# @dsh-forge/presets

Composable presets that load ready-made combinations of DSH Forge plugins.

## Installation

```bash
pnpm add @dsh-forge/presets
```

## Requirements

- Node.js >= 20
- The upstream binaries for each plugin in the preset (see each plugin README)

## Presets

| Preset | Plugins |
|---|---|
| `coding` | ast-grep, ruff, biome |
| `python` | ruff, uv |
| `web` | biome, ast-grep |
| `security` | semgrep, trivy, quality-gate |
| `devops` | act, docker, k6 |
| `media` | ffmpeg |
| `full` | all 12 plugins |

## API

```ts
import { PRESETS, resolvePreset, resolvePresetOrThrow, validatePreset, presetToolNames } from "@dsh-forge/presets";

const python = resolvePreset("python"); // Preset | undefined
validatePreset(python!);                // { ok: true } | { ok: false, error }
presetToolNames(resolvePresetOrThrow("full")); // every registered tool name
```

## License

MIT.
