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
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  parseJsonOutput,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ExecutionResult,
} from "@dsh-forge/core";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveFfmpegBinary,
  resolveFfprobeBinary,
  FFMPEG_BINARY_HINT,
  FFPROBE_BINARY_HINT,
} from "./binary.js";

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message: "ffmpeg media writes require explicit approval (workspace-write)",
    },
  };
}

/** Redact embedded credentials from text before it reaches the model. */
function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/([A-Za-z0-9_.-]+):([^@\s/]+)@/g, "$1:***@");
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "ffmpeg failed",
    error: { code: "ToolFailure", message: redactCredentials(message) },
  };
}

/** First non-empty stderr line (credential-redacted) or a stable fallback. */
function firstErrorLine(tool: string, exitCode: number, stderr: string): string {
  const line = stderr.trim().split("\n").find((l) => l.trim() !== "");
  return redactCredentials(line ?? `${tool} exited with code ${exitCode}`);
}

/** True when the string contains control characters (\\x00-\\x1f, \\x7f). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Reject empty, leading-dash or control-character paths (flag injection).
 * Control characters are rejected because a path with \\n/\\r written into the
 * ffmpeg concat list file would become a literal directive line (arbitrary-
 * file-read via -safe 0), bypassing the workspace boundary.
 */
function isValidPathInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !hasControlChars(value)
  );
}

/** Reject empty/leading-dash/whitespace codec names (flag injection). */
function isValidCodec(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !/\s/.test(value)
  );
}

/** Reject empty/leading-dash/whitespace ffmpeg timestamps. */
function isValidTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !/\s/.test(value)
  );
}

type Exec = ExecutionResult & { exitCode: number };

/**
 * Run an ffmpeg/ffprobe CLI command through the core runner. Only
 * BinaryNotFound, Timeout, truncated output, runner errors and signal-death
 * (null exit code) fail here; a non-zero exit code is passed through so
 * callers can interpret it.
 */
async function runBinary(
  ctx: ToolContext,
  binary: string,
  hint: string,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; exec: Exec } | { ok: false; result: ToolResult }> {
  const name = basename(binary).replace(/\.exe$/i, "");
  const timeoutMs = opts.timeoutMs ?? 300_000;
  let exec: ExecutionResult;
  try {
    // No `env` is passed: core's DEFAULT_ENV_ALLOWLIST is applied to every
    // child (never the full inherited environment), so harness secrets such
    // as DEEPSEEK_API_KEY can never reach ffmpeg/ffprobe while they parse
    // untrusted media. Verified by a test against runProcess.
    exec = await ctx.run({
      binary,
      args: [...args],
      cwd: ctx.workspaceRoot,
      timeoutMs,
      maxOutputBytes: 20 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      result: toolFailure(`${name} runner threw: ${String(err)}`),
    };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `${name} binary not found (${binary})`,
        error: { code: "BinaryNotFound", message: hint },
      },
    };
  }
  if (exec.timedOut || exec.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `${name} timed out`,
        error: { code: "Timeout", message: `${name} exceeded the ${timeoutMs}ms timeout` },
      },
    };
  }
  if (exec.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `${name} output exceeded the cap`,
        error: {
          code: "ToolFailure",
          message: `${name} output exceeded the 20 MiB output cap; the result was truncated`,
        },
      },
    };
  }
  if (exec.error) {
    return { ok: false, result: toolFailure(exec.error.message) };
  }
  if (exec.exitCode === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `${name} terminated abnormally`,
        error: {
          code: "ToolFailure",
          message: `${name} was killed or crashed (no exit code); the result is unreliable`,
        },
      },
    };
  }
  return { ok: true, exec: { ...exec, exitCode: exec.exitCode } };
}

/** Reject playlist containers (HLS/m3u) that dereference external files. */
function isPlaylistPath(p: string): boolean {
  return /\.(m3u8?|m3u)$/i.test(p);
}

/**
 * Dereferencing manifest markers that ffmpeg auto-detects by content
 * (av_stristr substring scan over its probe buffer): HLS (#EXTM3U / #EXTINF),
 * DASH MPD and Smooth Streaming. Detection must match ffmpeg's own scan (bare
 * substring anywhere in the head, case-insensitive), so a renamed or padded
 * manifest is caught regardless of a leading DOCTYPE/comment.
 */
const MANIFEST_MARKERS = [
  "#extm3u",
  "#extinf",
  "<mpd",
  "<smoothstreamingmedia",
] as const;

/**
 * ffmpeg's default probe buffer is 5,000,000 bytes; the guard scans that whole
 * window with margin (8 MiB) so a manifest marker anywhere ffmpeg would
 * auto-detect it is caught. Every ffmpeg/ffprobe invocation also clamps
 * -probesize to this window, so ffmpeg can never scan further than the guard.
 */
const PROBE_WINDOW_BYTES = 8 * 1024 * 1024; // 8 MiB >= ffmpeg's 5,000,000 B default
const PROBE_WINDOW = "8M"; // ffmpeg -probesize value matching PROBE_WINDOW_BYTES

/**
 * True when the file's leading bytes contain a dereferencing manifest marker
 * anywhere (ffmpeg auto-detects HLS/DASH/Smooth by content, not extension, so
 * a renamed manifest would still dereference external files). This bounded
 * head read mirrors ffmpeg's probe scan without loading a large media file.
 *
 * Only regular files are scanned: a FIFO/pipe/socket/device would block the
 * synchronous open/read on the Node main thread (unkillable harness DoS), so
 * stat() (which never blocks on a FIFO) gates the open.
 */
function hasPlaylistSignature(absolute: string): boolean {
  try {
    if (!statSync(absolute).isFile()) return false;
  } catch {
    // missing/unreadable input — let ffmpeg report it
    return false;
  }
  let fd: number | undefined;
  try {
    fd = openSync(absolute, "r");
    const buf = Buffer.alloc(PROBE_WINDOW_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString("utf8").toLowerCase();
    return MANIFEST_MARKERS.some((m) => head.includes(m));
  } catch {
    // unreadable/missing input — let ffmpeg report it
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Resolve a workspace-relative input path; never throws. */
function resolveInput(
  ctx: ToolContext,
  path: string,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(path)) {
    return {
      ok: false,
      result: invalid("input must be a non-empty workspace path"),
    };
  }
  try {
    const absolute = resolveInWorkspace(ctx.workspaceRoot, path);
    // A FIFO/pipe/socket/device input would block a synchronous open/read on
    // the Node main thread (unkillable harness DoS — the tool timeout only
    // bounds the child process) and a directory cannot be probed. stat() never
    // blocks on a FIFO, so non-regular inputs are rejected before any open.
    // Missing files are left for ffmpeg to report.
    let inputStat: ReturnType<typeof statSync> | undefined;
    try {
      inputStat = statSync(absolute);
    } catch {
      inputStat = undefined;
    }
    if (inputStat !== undefined && !inputStat.isFile()) {
      return {
        ok: false,
        result: invalid(
          "input must be a regular file (FIFOs, sockets, devices and directories are not supported)",
        ),
      };
    }
    // Playlist containers (HLS/m3u) dereference external file/URL references
    // inside the playlist. With -protocol_whitelist file,pipe,fd a workspace
    // .m3u8 makes the demuxer read arbitrary local media (boundary bypass for
    // the read tool, confused-deputy copy-into-workspace for the write tools).
    // Reject by extension AND by content signature (ffmpeg auto-detects HLS
    // by content, so a renamed playlist is caught too).
    if (isPlaylistPath(absolute) || hasPlaylistSignature(absolute)) {
      return {
        ok: false,
        result: invalid(
          "manifest containers (HLS/DASH/Smooth Streaming) are not supported: they dereference external files",
        ),
      };
    }
    return { ok: true, absolute };
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${path}` },
        },
      };
    }
    return {
      ok: false,
      result: toolFailure(`input path could not be resolved: ${String(err)}`),
    };
  }
}

/**
 * Resolve a workspace-relative output path and enforce the overwrite guard:
 * an existing output is refused unless overwrite=true. The caller also passes
 * -n (never overwrite) / -y to ffmpeg so a TOCTOU race cannot silently
 * overwrite either.
 */
function resolveOutput(
  ctx: ToolContext,
  output: string,
  overwrite: boolean,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(output)) {
    return {
      ok: false,
      result: invalid("output must be a non-empty workspace path"),
    };
  }
  let absolute: string;
  try {
    absolute = resolveInWorkspace(ctx.workspaceRoot, output);
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${output}` },
        },
      };
    }
    return {
      ok: false,
      result: toolFailure(`output path could not be resolved: ${String(err)}`),
    };
  }
  if (!overwrite && existsSync(absolute)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "output exists",
        error: {
          code: "ToolFailure",
          message: `output already exists: ${output}; set overwrite=true to replace it`,
        },
      },
    };
  }
  return { ok: true, absolute };
}

function okResult(summary: string, raw: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...[truncated]" : raw,
  };
}

/** -n (never overwrite) or -y (overwrite) global ffmpeg flag. */
function overwriteFlag(overwrite: boolean): string {
  return overwrite ? "-y" : "-n";
}

const mediaProbe: ToolDefinition = {
  name: "media_probe",
  description:
    "Probe a media file with ffprobe and report format + stream metadata (read-only). Playlist containers (.m3u8/.m3u) are rejected because they dereference external files.",  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "workspace-relative path to a media file",
      },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { input } = validated.value as { input: string };
    const resolved = resolveInput(ctx, input);
    if (!resolved.ok) return resolved.result;
    const run = await runBinary(
      ctx,
      resolveFfprobeBinary(),
      FFPROBE_BINARY_HINT,
      [
        // -protocol_whitelist blocks network protocols (http/https/rtsp/...), so
        // a hostile playlist cannot trigger SSRF (e.g. cloud-metadata URLs).
        // Local `file://` references inside a hostile playlist remain readable
        // by the harness user — a documented residual risk for untrusted media
        // (ffmpeg's HLS demuxer additionally restricts segment extensions by
        // default). -probesize clamps ffmpeg's auto-detection window to the
        // guard window (PROBE_WINDOW_BYTES), so a manifest marker beyond it is
        // never dereferenced.
        "-protocol_whitelist",
        "file,pipe,fd",
        "-probesize",
        PROBE_WINDOW,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        resolved.absolute,
      ],
      { timeoutMs: 60_000 },
    );
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine("ffprobe", run.exec.exitCode, run.exec.stderr));
    }
    const parsed = parseJsonOutput("ffprobe", run.exec.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        summary: "ffprobe parse failed",
        error: { code: "ParseFailure", message: parsed.error },
      };
    }
    const data = parsed.value as Record<string, unknown>;
    if (typeof data !== "object" || data === null) {
      return {
        ok: false,
        summary: "ffprobe parse failed",
        error: {
          code: "ParseFailure",
          message: "ffprobe: expected a JSON object",
        },
      };
    }
    const format = (data.format as Record<string, unknown> | undefined) ?? {};
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const kinds = streams
      .map((s) => (s as Record<string, unknown>).codec_type)
      .filter((t) => typeof t === "string")
      .join(",");
    const fmt = typeof format.format_name === "string" ? format.format_name : "?";
    const dur = typeof format.duration === "string" ? `${format.duration}s` : "?";
    const summary = `media probe: ${fmt}, duration ${dur}, ${streams.length} stream(s) [${kinds || "none"}]`;
    // ffprobe JSON carries format.filename, which can embed credentials in the
    // path; redact the model-visible raw.
    return okResult(
      summary,
      redactCredentials(JSON.stringify(data, null, 2)),
    );
  },
};

interface WriteArgs {
  input?: string;
  inputs?: string[];
  output: string;
  overwrite?: boolean;
  start?: string;
  duration?: string;
  time?: string;
  codec?: string;
  audioCodec?: string;
  crf?: number;
}

/**
 * Shared executor for ffmpeg write tools: resolves input(s) + output inside
 * the workspace, enforces the overwrite guard, runs ffmpeg, returns a
 * canonical result.
 */
async function runWrite(
  ctx: ToolContext,
  args: WriteArgs,
  buildArgv: (
    inputArgs: { input?: string; inputs?: string[]; outputAbs: string; overwrite: boolean },
  ) => string[],
  action: string,
  extra?: (args: WriteArgs) => { ok: true } | { ok: false; result: ToolResult },
): Promise<ToolResult> {
  if (!assertPermission("workspace-write", ctx.permission ?? { approved: false })) {
    return permissionDenied();
  }
  const overwrite = args.overwrite === true;
  const output = resolveOutput(ctx, args.output, overwrite);
  if (!output.ok) return output.result;
  let input: string | undefined;
  if (args.input !== undefined) {
    const r = resolveInput(ctx, args.input);
    if (!r.ok) return r.result;
    input = r.absolute;
  }
  let inputs: string[] | undefined;
  if (args.inputs !== undefined) {
    if (!Array.isArray(args.inputs) || args.inputs.length === 0) {
      return invalid("inputs must be a non-empty array of workspace paths");
    }
    const resolved: string[] = [];
    for (const p of args.inputs) {
      if (typeof p !== "string") return invalid("each input must be a string path");
      const r = resolveInput(ctx, p);
      if (!r.ok) return r.result;
      resolved.push(r.absolute);
    }
    inputs = resolved;
  }
  if (extra) {
    const v = extra(args);
    if (!v.ok) return v.result;
  }
  const argv = buildArgv({ input, inputs, outputAbs: output.absolute, overwrite });
  // -hide_banner -v error: suppresses ffmpeg's version banner and info output
  // so the first non-empty stderr line on failure is the real error (not the
  // banner). -protocol_whitelist file,pipe,fd blocks network protocols (SSRF);
  // local file:// references inside hostile playlists remain readable by the
  // harness user (documented residual risk). -probesize clamps ffmpeg's
  // auto-detection window to the guard window (PROBE_WINDOW_BYTES), so a
  // manifest marker beyond it is never dereferenced.
  const run = await runBinary(
    ctx,
    resolveFfmpegBinary(),
    FFMPEG_BINARY_HINT,
    [
      "-hide_banner",
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe,fd",
      "-probesize",
      PROBE_WINDOW,
      ...argv,
    ],
  );
  if (!run.ok) return run.result;
  if (run.exec.exitCode !== 0) {
    return toolFailure(firstErrorLine("ffmpeg", run.exec.exitCode, run.exec.stderr));
  }
  // ffmpeg echoes the full input/output paths on stderr; a workspace path
  // containing user:pass@ or scheme://user@ would leak into the model-visible
  // result, so the success-path raw is credential-redacted too.
  return okResult(
    `${action} -> ${args.output}`,
    redactCredentials(run.exec.stdout + run.exec.stderr),
  );
}

const videoClip: ToolDefinition = {
  name: "video_clip",
  description:
    "Extract a clip from a media file (workspace-write: writes a new file; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input media" },
      start: { type: "string", description: "start timestamp, e.g. 0, 00:00:01, 1.5" },
      duration: { type: "string", description: "clip duration, e.g. 0.1, 10, 00:00:05" },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "start", "duration", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (!isValidTime(a.start) || !isValidTime(a.duration)) {
      return invalid("start and duration must be non-empty timestamps");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-ss",
      (a.start as string).trim(),
      "-t",
      (a.duration as string).trim(),
      "-c",
      "copy",
      outputAbs,
    ], "clipped");
  },
};

const videoTranscode: ToolDefinition = {
  name: "video_transcode",
  description:
    "Transcode a media file to another codec (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input media" },
      codec: { type: "string", description: "video codec (default libx264)" },
      audioCodec: { type: "string", description: "audio codec (default aac)" },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (a.codec !== undefined && !isValidCodec(a.codec)) {
      return invalid("codec must be a non-empty codec name");
    }
    if (a.audioCodec !== undefined && !isValidCodec(a.audioCodec)) {
      return invalid("audioCodec must be a non-empty codec name");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-c:v",
      (a.codec ?? "libx264").trim(),
      "-c:a",
      (a.audioCodec ?? "aac").trim(),
      outputAbs,
    ], "transcoded");
  },
};

const videoConcat: ToolDefinition = {
  name: "video_concat",
  description:
    "Concatenate media files with the same codecs (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      inputs: {
        type: "array",
        items: { type: "string" },
        description: "workspace-relative media files to concatenate (same codecs)",
      },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["inputs", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (!assertPermission("workspace-write", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const overwrite = a.overwrite === true;
    const output = resolveOutput(ctx, a.output, overwrite);
    if (!output.ok) return output.result;
    if (!Array.isArray(a.inputs) || a.inputs.length === 0) {
      return invalid("inputs must be a non-empty array of workspace paths");
    }
    const resolved: string[] = [];
    for (const p of a.inputs) {
      if (typeof p !== "string") return invalid("each input must be a string path");
      // ffmpeg's concat demuxer (av_get_token) cannot represent a single
      // quote inside a quoted token — it truncates at the quote, silently
      // concatenating a different file. Reject such paths outright.
      if (p.includes("'")) {
        return invalid("input path cannot contain a single quote");
      }
      const r = resolveInput(ctx, p);
      if (!r.ok) return r.result;
      resolved.push(r.absolute);
    }
    // ffmpeg concat list format: av_get_token treats '\' as an escape, so a
    // literal backslash in a filename (legal on POSIX, where the boundary
    // check preserves it) is written as '\\'. We deliberately do NOT
    // normalize '\' to '/' here: on POSIX that rewrite happens after the
    // workspace-boundary check and would synthesize forward-slash '..'
    // traversal (arbitrary file read via -safe 0). On Windows core's
    // resolveInWorkspace already returns forward slashes, so no rewrite is
    // needed. Paths are single-quote-free (validated above).
    const runtime = mkdtempSync(join(tmpdir(), "dsh-ffmpeg-concat-"));
    try {
      const list = resolved
        .map((p) => `file '${p.replace(/\\/g, "\\\\")}'`)
        .join("\n");
      const listPath = join(runtime, "list.txt");
      writeFileSync(listPath, list + "\n", "utf8");
      const run = await runBinary(
        ctx,
        resolveFfmpegBinary(),
        FFMPEG_BINARY_HINT,
        [
          "-hide_banner",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe,fd",
          "-probesize",
          PROBE_WINDOW,
          overwriteFlag(overwrite),
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          output.absolute,
        ],
      );
      if (!run.ok) return run.result;
      if (run.exec.exitCode !== 0) {
        return toolFailure(firstErrorLine("ffmpeg", run.exec.exitCode, run.exec.stderr));
      }
      return okResult(
        `concatenated -> ${a.output}`,
        redactCredentials(run.exec.stdout + run.exec.stderr),
      );
    } finally {
      // best-effort cleanup (a throw must never become an unhandled rejection)
      try {
        rmSync(runtime, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
};

const audioExtract: ToolDefinition = {
  name: "audio_extract",
  description:
    "Extract the audio track from a media file (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input media" },
      codec: { type: "string", description: "audio codec (default aac)" },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (a.codec !== undefined && !isValidCodec(a.codec)) {
      return invalid("codec must be a non-empty codec name");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-vn",
      "-c:a",
      (a.codec ?? "aac").trim(),
      outputAbs,
    ], "extracted audio");
  },
};

const audioConvert: ToolDefinition = {
  name: "audio_convert",
  description:
    "Convert an audio file to another codec (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input audio" },
      codec: { type: "string", description: "audio codec (default mp3)" },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (a.codec !== undefined && !isValidCodec(a.codec)) {
      return invalid("codec must be a non-empty codec name");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-c:a",
      (a.codec ?? "mp3").trim(),
      outputAbs,
    ], "converted audio");
  },
};

const thumbnailGenerate: ToolDefinition = {
  name: "thumbnail_generate",
  description:
    "Generate a thumbnail frame from a media file (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input media" },
      time: { type: "string", description: "timestamp for the frame (default 00:00:01)" },
      output: { type: "string", description: "workspace-relative output image" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    if (a.time !== undefined && !isValidTime(a.time)) {
      return invalid("time must be a non-empty timestamp");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-ss",
      (a.time ?? "00:00:01").trim(),
      "-vframes",
      "1",
      outputAbs,
    ], "generated thumbnail");
  },
};

const mediaCompress: ToolDefinition = {
  name: "media_compress",
  description:
    "Compress a media file with a CRF (0-51; lower = higher quality) (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "workspace-relative input media" },
      crf: { type: "number", description: "CRF quality factor, 0-51 (default 28)" },
      output: { type: "string", description: "workspace-relative output file" },
      overwrite: { type: "boolean", description: "replace the output if it exists" },
    },
    required: ["input", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as unknown as WriteArgs;
    const crf = a.crf ?? 28;
    if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
      return invalid("crf must be an integer between 0 and 51");
    }
    return runWrite(ctx, a, ({ input, outputAbs, overwrite }) => [
      overwriteFlag(overwrite),
      "-i",
      input!,
      "-crf",
      String(crf),
      outputAbs,
    ], "compressed");
  },
};

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
    version: "0.3.0",
    upstreamTool: "ffmpeg",
    coreContractVersion: "0.3.0",
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
  tools: [
    mediaProbe,
    videoClip,
    videoTranscode,
    videoConcat,
    audioExtract,
    audioConvert,
    thumbnailGenerate,
    mediaCompress,
  ],
};

export { resolveFfmpegBinary, resolveFfprobeBinary };

export default ffmpegPlugin;
