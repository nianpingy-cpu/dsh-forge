# @dsh-forge/plugin-ffmpeg

Typed FFmpeg/ffprobe adapter: media probe, clip, transcode, concat, audio
extract/convert, thumbnail, and compression.

## Installation

```bash
pnpm add @dsh-forge/plugin-ffmpeg
```

## Requirements

- Node.js >= 20
- `ffmpeg` + `ffprobe` binaries on PATH — see
  <https://ffmpeg.org/download.html> (or `ffmpeg-static`); `ffprobe` ships
  with ffmpeg.

## Tools

| Tool | MutationClass | Arguments |
|---|---|---|
| `media_probe` | read | `input: string` (required) |
| `video_clip` | workspace-write | `input`, `start`, `duration`, `output` (all required), `overwrite?` |
| `video_transcode` | workspace-write | `input` (required), `codec?`, `audioCodec?`, `output` (required), `overwrite?` |
| `video_concat` | workspace-write | `inputs: string[]` (required), `output` (required), `overwrite?` |
| `audio_extract` | workspace-write | `input` (required), `codec?`, `output` (required), `overwrite?` |
| `audio_convert` | workspace-write | `input` (required), `codec?`, `output` (required), `overwrite?` |
| `thumbnail_generate` | workspace-write | `input` (required), `time?`, `output` (required), `overwrite?` |
| `media_compress` | workspace-write | `input` (required), `crf?: number` (0-51, default 28), `output` (required), `overwrite?` |

## Result schema

All tools return raw output only (redacted).

## Permission behavior

- `media_probe` is read.
- All other tools are `workspace-write` and require permission approval;
  outputs default to no-overwrite (`-n`) unless `overwrite: true`.
- HLS/DASH/MPD content signing is rejected; network protocols are restricted
  to `file,pipe,fd`.

## Example

```text
media_probe(input: "input.mp4")
  → metadata
  → video_clip(input: "input.mp4", start: "00:00:10", duration: "00:00:05", output: "clip.mp4")
  → media_compress(input: "clip.mp4", crf: 28, output: "clip-small.mp4")
```

## Troubleshooting

- `BinaryNotFound`: install ffmpeg/ffprobe and ensure they are on PATH.
- `ToolFailure`: the operation failed — check the redacted `message`.

## Compatibility

Tested against FFmpeg; integration targets the pinned DeepSeek Harness commit
in `compatibility/deepseek-harness.json`.

## License

MIT. FFmpeg remains governed by its upstream license.
