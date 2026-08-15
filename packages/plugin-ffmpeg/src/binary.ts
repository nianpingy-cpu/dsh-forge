/**
 * Binary resolution for ffmpeg/ffprobe (ISSUE-023).
 *
 * ffmpeg/ffprobe ship as platform binaries (or the ffmpeg-static npm shim),
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 *
 * Resolution invariants (from external security review of the act plugin):
 *  1. NEVER return a bare name — on Windows, CreateProcess resolves a bare
 *     name by searching the parent process's cwd (often the workspace being
 *     analyzed) before PATH. Every resolved binary is an absolute path.
 *  2. When absent, return a RANDOM, non-existent absolute path (never a
 *     predictable path in a world-writable dir like /tmp). Spawning it yields
 *     ENOENT, which the core runner maps to BinaryNotFound.
 *  3. Relative PATH entries are skipped.
 */
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const IS_WINDOWS = process.platform === "win32";

function resolveInPath(name: string): string | undefined {
  const candidates = IS_WINDOWS ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(dir)) continue;
    for (const candidate of candidates) {
      try {
        const full = join(dir, candidate);
        if (statSync(full).isFile()) return full;
      } catch {
        // continue searching
      }
    }
  }
  return undefined;
}

/** Unpredictable absolute path that never exists (spawn -> ENOENT). */
function missingSentinel(name: string): string {
  return join(tmpdir(), `dsh-missing-${randomUUID()}`, name);
}

/** Resolve the ffmpeg binary from PATH; never falls back to a bare name. */
export function resolveFfmpegBinary(): string {
  return (
    resolveInPath("ffmpeg") ??
    missingSentinel(IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg")
  );
}

/** Resolve the ffprobe binary from PATH; never falls back to a bare name. */
export function resolveFfprobeBinary(): string {
  return (
    resolveInPath("ffprobe") ??
    missingSentinel(IS_WINDOWS ? "ffprobe.exe" : "ffprobe")
  );
}

export const FFMPEG_BINARY_HINT =
  "install ffmpeg: see https://ffmpeg.org/download.html (or the ffmpeg-static npm package)";
export const FFPROBE_BINARY_HINT =
  "install ffprobe (ships with ffmpeg): see https://ffmpeg.org/download.html";
