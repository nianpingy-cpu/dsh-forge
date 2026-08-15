/**
 * FFmpeg adapter (ISSUE-023) — media probe / edit tools.
 *
 * Typed arguments are compiled to ffmpeg/ffprobe argv[] — never a free-form
 * `ffmpeg(command)` string (ADR-004, no arbitrary shell execution). Writes are
 * workspace-gated (workspace-write) with an overwrite guard: outputs inside
 * the workspace are never replaced unless `overwrite: true` (ffmpeg runs with
 * -n, never -y, unless overwrite is requested).
 *
 *   media_probe         (read)             ffprobe -print_format json
 *   video_clip          (workspace-write)  ffmpeg -ss -t -c copy
 *   video_transcode     (workspace-write)  ffmpeg -c:v -c:a
 *   video_concat        (workspace-write)  ffmpeg -f concat -safe 0 -i list
 *   audio_extract       (workspace-write)  ffmpeg -vn -c:a
 *   audio_convert       (workspace-write)  ffmpeg -c:a
 *   thumbnail_generate  (workspace-write)  ffmpeg -ss -vframes 1
 *   media_compress      (workspace-write)  ffmpeg -crf
 *
 * (RED — the tools below are not implemented yet; tests are failing.)
 */
import { type ToolDefinition } from "@dsh-forge/core";
import {
  resolveFfmpegBinary,
  resolveFfprobeBinary,
  FFMPEG_BINARY_HINT,
  FFPROBE_BINARY_HINT,
} from "./binary.js";

export const ffmpegPlugin: {
  metadata: {
    name: string;
    version: string;
    upstreamTool: string;
    coreContractVersion: string;
    capabilities: readonly string[];
  };
  tools: readonly ToolDefinition[];
} = {
  metadata: {
    name: "@dsh-forge/plugin-ffmpeg",
    version: "0.1.0",
    upstreamTool: "ffmpeg",
    coreContractVersion: "0.1.0",
    capabilities: [
      "probe",
      "clip",
      "transcode",
      "concat",
      "audio-extract",
      "audio-convert",
      "thumbnail",
      "compress",
      "workspace-write",
    ],
  },
  tools: [],
};

export { resolveFfmpegBinary, resolveFfprobeBinary };

export default ffmpegPlugin;
