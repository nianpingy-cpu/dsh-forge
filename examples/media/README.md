# Example: media

FFmpeg media processing workflow.

## Scenario

Probe, clip, transcode, extract audio, and compress media files.

## Required binaries

- `ffmpeg` + `ffprobe` — <https://ffmpeg.org/download.html> (or `ffmpeg-static`)

## Steps

```text
1. media_probe(input: "input.mp4")                 # read: metadata
2. video_clip(input: "input.mp4", start: "00:00:10", duration: "00:00:05", output: "clip.mp4")
                                                   # workspace-write
3. audio_extract(input: "input.mp4", output: "audio.mp3")
                                                   # workspace-write
4. thumbnail_generate(input: "input.mp4", output: "thumb.jpg")
                                                   # workspace-write
5. media_compress(input: "clip.mp4", crf: 28, output: "clip-small.mp4")
                                                   # workspace-write
```

## Expected result

Media files are processed without arbitrary shell command construction;
outputs never overwrite unless `overwrite: true`.

## Permissions

All write tools are `workspace-write` and require permission approval.
