import { describe, expect, it, beforeAll } from "vitest";
import {
  mkdtempSync,
  cpSync,
  existsSync,
  statSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ffmpegPlugin,
  resolveFfmpegBinary,
  resolveFfprobeBinary,
} from "@dsh-forge/plugin-ffmpeg";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/ffmpeg", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-ffmpeg-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

function realRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  return runProcess(req);
}

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

let hasRealFfmpeg = false;
let hasRealFfprobe = false;
try {
  hasRealFfmpeg = statSync(resolveFfmpegBinary()).isFile();
} catch {
  // not installed
}
try {
  hasRealFfprobe = statSync(resolveFfprobeBinary()).isFile();
} catch {
  // not installed
}

const OK = {
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
};

const PROBE_JSON = JSON.stringify({
  format: { format_name: "wav", duration: "0.200000", size: "1644" },
  streams: [
    {
      index: 0,
      codec_type: "audio",
      codec_name: "pcm_u8",
      sample_rate: "8000",
      channels: 1,
    },
  ],
});

const FFMPEG_OUTPUT =
  "frame=    1 fps=0.0 q=-0.0 size=N/A time=00:00:00.20 bitrate=N/A speed= 1x";

function mockRunner(
  overrides: Record<string, ExecutionRunner> = {},
): ExecutionRunner {
  return async (req) => {
    const key = req.binary.toLowerCase();
    if (overrides[key]) return overrides[key](req);
    if (key.includes("ffprobe")) {
      return { exitCode: 0, stdout: PROBE_JSON, stderr: "", ...OK };
    }
    return { exitCode: 0, stdout: FFMPEG_OUTPUT, stderr: "", ...OK };
  };
}

/** Helper to capture the ExecutionRequest passed to ctx.run. */
function captureRunner(
  onCapture: (req: ExecutionRequest) => void,
  overrides: Partial<ExecutionResult> = {},
): ExecutionRunner {
  return async (req) => {
    onCapture(req);
    return {
      exitCode: 0,
      stdout: FFMPEG_OUTPUT,
      stderr: "",
      ...OK,
      ...overrides,
    };
  };
}

describe("resolve binaries", () => {
  it("resolves ffmpeg and ffprobe to absolute paths", () => {
    expect(isAbsolute(resolveFfmpegBinary())).toBe(true);
    expect(isAbsolute(resolveFfprobeBinary())).toBe(true);
  });

  it("uses unpredictable absolute sentinels when the binaries are absent", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "dsh-empty-" + randomUUID());
      const a = resolveFfmpegBinary();
      const b = resolveFfprobeBinary();
      expect(isAbsolute(a)).toBe(true);
      expect(isAbsolute(b)).toBe(true);
      expect(a).not.toBe("ffmpeg");
      expect(b).not.toBe("ffprobe");
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("media_probe (read)", () => {
  const tool = () => ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;

  it("probes a media file", async () => {
    const result = await tool().execute(
      { input: "tiny.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("wav");
    expect(result.raw).toContain("pcm_u8");
  });

  it("rejects an input outside the workspace", async () => {
    const result = await tool().execute(
      { input: "../outside/file.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an empty or leading-dash input", async () => {
    const a = await tool().execute({ input: "" }, ctx(mockRunner()));
    const b = await tool().execute({ input: "-f" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("surfaces malformed JSON as a ParseFailure", async () => {
    const bad: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: "{ not json",
      stderr: "",
      ...OK,
    });
    const result = await tool().execute({ input: "tiny.wav" }, ctx(bad));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("reports BinaryNotFound when ffprobe is missing", async () => {
    const missing: ExecutionRunner = async () => ({
      error: { code: "BinaryNotFound", message: "ENOENT" },
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ input: "tiny.wav" }, ctx(missing));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });
});

// Shared behavior for every workspace-write tool.
function writeToolBehavior(name: string, validArgs: Record<string, unknown>) {
  describe(name, () => {
    const tool = () => ffmpegPlugin.tools.find((t) => t.name === name)!;

    it("denies without permission approval (workspace-write)", async () => {
      const result = await tool().execute(
        { ...validArgs, output: "deny-out.wav" },
        ctx(mockRunner(), false),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("PermissionDenied");
    });

    it("refuses to overwrite an existing output without overwrite=true", async () => {
      writeFileSync(join(workspaceRoot, "existing-out.wav"), "x", "utf8");
      const result = await tool().execute(
        { ...validArgs, output: "existing-out.wav" },
        ctx(mockRunner()),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/exists|overwrite/i);
    });

    it("rejects an output outside the workspace", async () => {
      const result = await tool().execute(
        { ...validArgs, output: "../outside/out.wav" },
        ctx(mockRunner()),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("WorkspaceViolation");
    });

    it("rejects a leading-dash output (flag injection)", async () => {
      const result = await tool().execute(
        { ...validArgs, output: "-y" },
        ctx(mockRunner()),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("InvalidArguments");
    });

    it("passes -n (never overwrite) by default and -y when overwrite=true", async () => {
      let captured: ExecutionRequest | undefined;
      const resultDefault = await tool().execute(
        { ...validArgs, output: "fresh-out.wav" },
        ctx(captureRunner((req) => (captured = req))),
      );
      expect(resultDefault.ok).toBe(true);
      expect(captured!.args).toContain("-n");

      writeFileSync(join(workspaceRoot, "existing-out.wav"), "x", "utf8");
      captured = undefined;
      const resultOverwrite = await tool().execute(
        { ...validArgs, output: "existing-out.wav", overwrite: true },
        ctx(captureRunner((req) => (captured = req))),
      );
      expect(resultOverwrite.ok).toBe(true);
      expect(captured!.args).toContain("-y");
    });
  });
}

writeToolBehavior("video_clip", {
  input: "tiny.wav",
  start: "0",
  duration: "0.1",
});
writeToolBehavior("video_transcode", { input: "tiny.wav" });
writeToolBehavior("video_concat", { inputs: ["tiny.wav"] });
writeToolBehavior("audio_extract", { input: "tiny.wav" });
writeToolBehavior("audio_convert", { input: "tiny.wav" });
writeToolBehavior("thumbnail_generate", { input: "tiny.wav", time: "0" });
writeToolBehavior("media_compress", { input: "tiny.wav" });

describe("tool-specific validation", () => {
  const clip = () => ffmpegPlugin.tools.find((t) => t.name === "video_clip")!;
  const transcode = () =>
    ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
  const compress = () =>
    ffmpegPlugin.tools.find((t) => t.name === "media_compress")!;

  it("video_clip rejects an empty or leading-dash start/duration", async () => {
    const a = await clip().execute(
      { input: "tiny.wav", start: "", duration: "0.1", output: "o.wav" },
      ctx(mockRunner()),
    );
    const b = await clip().execute(
      { input: "tiny.wav", start: "--ss", duration: "0.1", output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("video_transcode rejects a leading-dash codec", async () => {
    const result = await transcode().execute(
      { input: "tiny.wav", codec: "-vcodec", output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("media_compress rejects an out-of-range crf", async () => {
    const a = await compress().execute(
      { input: "tiny.wav", crf: 99, output: "o.wav" },
      ctx(mockRunner()),
    );
    const b = await compress().execute(
      { input: "tiny.wav", crf: -1, output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("rejects control characters in paths (concat list injection)", async () => {
    const concat = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_concat")!;
    const result = await concat().execute(
      { inputs: ["tiny.wav\nfile '/etc/passwd'"], output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");

    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const probed = await probe().execute(
      { input: "tiny\r.wav" },
      ctx(mockRunner()),
    );
    expect(probed.ok).toBe(false);
    expect(probed.error?.code).toBe("InvalidArguments");
  });

  it("rejects single quotes in concat inputs (av_get_token cannot represent them)", async () => {
    const concat = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_concat")!;
    const result = await concat().execute(
      { inputs: ["a'b.wav"], output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects playlist containers (.m3u8/.m3u) on the read tool (no boundary bypass)", async () => {
    writeFileSync(join(workspaceRoot, "evil.m3u8"), "#EXTM3U", "utf8");
    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const result = await probe().execute(
      { input: "evil.m3u8" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
    expect(result.error?.message).toMatch(/manifest|playlist/i);
  });

  it("rejects playlist containers on write tools (no confused deputy)", async () => {
    writeFileSync(join(workspaceRoot, "evil.m3u"), "#EXTM3U", "utf8");
    const transcode = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    const result = await transcode().execute(
      { input: "evil.m3u", output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
    expect(result.error?.message).toMatch(/manifest|playlist/i);
  });

  it("rejects a renamed playlist by content signature (ffmpeg auto-detects HLS by content)", async () => {
    // photo.mp4 has a media extension but HLS content — ffmpeg would demux it
    // as HLS and dereference external files; the content guard must reject it.
    writeFileSync(
      join(workspaceRoot, "photo.mp4"),
      "#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1280000\nfile:///tmp/secret.mp4",
      "utf8",
    );
    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const probed = await probe().execute(
      { input: "photo.mp4" },
      ctx(mockRunner()),
    );
    expect(probed.ok).toBe(false);
    expect(probed.error?.code).toBe("InvalidArguments");
    expect(probed.error?.message).toMatch(/manifest|playlist/i);

    const transcode = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    const written = await transcode().execute(
      { input: "photo.mp4", output: "o.wav" },
      ctx(mockRunner()),
    );
    expect(written.ok).toBe(false);
    expect(written.error?.code).toBe("InvalidArguments");
    expect(written.error?.message).toMatch(/manifest|playlist/i);
  });

  it("rejects a DASH MPD manifest by content signature", async () => {
    writeFileSync(
      join(workspaceRoot, "clip.mpd"),
      '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><BaseURL>file:///tmp/private/video.mp4</BaseURL></MPD>',
      "utf8",
    );
    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const probed = await probe().execute({ input: "clip.mpd" }, ctx(mockRunner()));
    expect(probed.ok).toBe(false);
    expect(probed.error?.code).toBe("InvalidArguments");
    expect(probed.error?.message).toMatch(/manifest|playlist/i);
  });

  it("does not rewrite backslashes into traversal in the concat list (POSIX)", async () => {
    if (process.platform === "win32") return; // Windows resolves \\ differently
    let listContent = "";
    const reader: ExecutionRunner = async (req) => {
      const i = req.args.indexOf("-i");
      const listPath = req.args[i + 1];
      if (listPath && existsSync(listPath)) {
        listContent = readFileSync(listPath, "utf8");
      }
      return { exitCode: 0, stdout: "ok", stderr: "", ...OK };
    };
    const concat = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_concat")!;
    const result = await concat().execute(
      { inputs: ["..\\..\\..\\tmp\\secret.mp4"], output: "o.wav" },
      ctx(reader),
    );
    expect(result.ok).toBe(true);
    // The literal backslash path must NOT be rewritten into forward-slash
    // '..' traversal (which -safe 0 would honor as an arbitrary file read).
    expect(listContent).not.toContain("../../../");
    expect(listContent).not.toMatch(/\/file '[^']*\/\.\.\//);
    // Backslashes are escaped for av_get_token (\\ -> literal \), preserved.
    expect(listContent).toContain("..\\\\..\\\\..\\\\tmp\\\\secret.mp4");
  });

  it("redacts embedded credentials from successful write output", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    const leaky: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: "Output #0, to 'http://user:supersecret@host/out.wav':",
      stderr: "",
      ...OK,
    });
    const result = await tool().execute(
      { input: "tiny.wav", output: "o.wav" },
      ctx(leaky),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).not.toContain("supersecret");
    expect(result.raw).toContain("***@");
  });

  it("redacts embedded credentials from probe output", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const leaky: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        format: {
          format_name: "wav",
          filename: "http://user:supersecret@host/x.wav",
        },
      }),
      stderr: "",
      ...OK,
    });
    const result = await tool().execute({ input: "tiny.wav" }, ctx(leaky));
    expect(result.ok).toBe(true);
    expect(result.raw).not.toContain("supersecret");
  });

  it("surfaces the real ffmpeg error, not the version banner", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    let captured: ExecutionRequest | undefined;
    const fail: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Could not find a suitable output format for 'o.wav'",
        ...OK,
      };
    };
    const result = await tool().execute(
      { input: "tiny.wav", output: "o.wav" },
      ctx(fail),
    );
    expect(captured!.args).toContain("-hide_banner");
    expect(captured!.args).toContain("-v");
    expect(captured!.args).toContain("error");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Could not find a suitable output format");
    expect(result.error?.message).not.toContain("ffmpeg version");
  });

  it("blocks writes through a symlink escaping the workspace (output)", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    // Create the target first so the symlink is non-dangling: core's
    // canonicalize then realpaths it to the outside location and the boundary
    // check reports WorkspaceViolation (a dangling symlink would rethrow ENOENT
    // as ToolFailure instead).
    const target = join(workspaceRoot, "..", "outside.wav");
    writeFileSync(target, "x", "utf8");
    const linkPath = join(workspaceRoot, "escape-out.wav");
    try {
      symlinkSync(target, linkPath, "file");
    } catch {
      return; // symlinks unavailable (e.g. Windows without privileges); skip
    }
    const result = await tool().execute(
      { input: "tiny.wav", output: "escape-out.wav" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("blocks reads through a symlink escaping the workspace (input)", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const target = join(workspaceRoot, "..", "secret.wav");
    writeFileSync(target, "x", "utf8");
    const linkPath = join(workspaceRoot, "escape-in.wav");
    try {
      symlinkSync(target, linkPath, "file");
    } catch {
      return; // symlinks unavailable (e.g. Windows without privileges); skip
    }
    const result = await tool().execute({ input: "escape-in.wav" }, ctx(mockRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("passes -protocol_whitelist to ffprobe and ffmpeg (no SSRF / file-protocol reads)", async () => {
    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const transcode = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    const calls: string[][] = [];
    const recorder: ExecutionRunner = async (req) => {
      calls.push([...req.args]);
      return { exitCode: 0, stdout: FFMPEG_OUTPUT, stderr: "", ...OK };
    };
    await probe().execute({ input: "tiny.wav" }, ctx(recorder));
    await transcode().execute({ input: "tiny.wav", output: "o.wav" }, ctx(recorder));
    for (const args of calls) {
      expect(args).toContain("-protocol_whitelist");
      expect(args).toContain("file,pipe,fd");
    }
  });

  it("never leaks harness secrets to child processes (core env allowlist)", async () => {
    const core = await import("@dsh-forge/core");
    process.env.DSH_TEST_SECRET = "sekret-value";
    try {
      const res = await core.runProcess({
        binary: process.execPath,
        args: ["-e", "console.log(process.env.DSH_TEST_SECRET ?? 'absent')"],
        cwd: workspaceRoot,
        timeoutMs: 10_000,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("sekret");
      expect(res.stdout).toContain("absent");
    } finally {
      delete process.env.DSH_TEST_SECRET;
    }
  });
});

describe("robustness", () => {
  it("treats a null exit code (killed/crashed ffmpeg) as a ToolFailure, not success", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_clip")!;
    const killed: ExecutionRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      ...OK,
    });
    const result = await tool().execute(
      { input: "tiny.wav", start: "0", duration: "0.1", output: "o.wav" },
      ctx(killed),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/killed|crashed/i);
  });

  it("surfaces a timeout as a ToolFailure", async () => {
    const tool = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_transcode")!;
    const slow: ExecutionRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      aborted: false,
      truncated: false,
      durationMs: 300_000,
    });
    const result = await tool().execute(
      { input: "tiny.wav", output: "o.wav" },
      ctx(slow),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("Timeout");
  });
});

describe("live ffmpeg (opt-in)", () => {
  it("probes and clips a self-generated tiny media file when ffmpeg is installed", async () => {
    if (!hasRealFfmpeg || !hasRealFfprobe) return;
    const gen = await realRunner({
      binary: resolveFfmpegBinary(),
      args: [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=64x64:rate=10",
        join(workspaceRoot, "tiny.mp4"),
      ],
      cwd: workspaceRoot,
      timeoutMs: 30_000,
    });
    if (gen.error || gen.exitCode !== 0) return; // environment cannot run ffmpeg; skip
    const probe = () =>
      ffmpegPlugin.tools.find((t) => t.name === "media_probe")!;
    const probed = await probe().execute(
      { input: "tiny.mp4" },
      ctx(realRunner),
    );
    expect(probed.ok).toBe(true);
    const clip = () =>
      ffmpegPlugin.tools.find((t) => t.name === "video_clip")!;
    const clipped = await clip().execute(
      { input: "tiny.mp4", start: "0", duration: "0.5", output: "clip.mp4" },
      ctx(realRunner),
    );
    expect(clipped.ok).toBe(true);
    expect(existsSync(join(workspaceRoot, "clip.mp4"))).toBe(true);
  }, 60_000);
});

describe("default export", () => {
  it("exports a default Plugin object (Plugin Standard)", async () => {
    const mod = await import("@dsh-forge/plugin-ffmpeg");
    const def = (
      mod as { default?: { metadata?: unknown; tools?: unknown } }
    ).default;
    expect(def).toBeTruthy();
    expect((def as { metadata: { name: string } }).metadata.name).toBe(
      "@dsh-forge/plugin-ffmpeg",
    );
    expect(Array.isArray((def as { tools: unknown[] }).tools)).toBe(true);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const routing: ExecutionRunner = async (req) => {
      if (req.binary.toLowerCase().includes("ffprobe")) {
        return { exitCode: 0, stdout: PROBE_JSON, stderr: "", ...OK };
      }
      return { exitCode: 0, stdout: FFMPEG_OUTPUT, stderr: "", ...OK };
    };
    const report = await runContractSuite(ffmpegPlugin, {
      workspaceRoot,
      runner: routing,
      // Read-only probe tool reaches ctx.run without a permission gate.
      missingBinaryTool: "media_probe",
      missingBinaryToolArgs: { input: "tiny.wav" },
      toolArgs: {
        media_probe: {
          valid: { input: "tiny.wav" },
          invalid: { input: 42 },
        },
        video_clip: {
          valid: { input: "tiny.wav", start: "0", duration: "0.1", output: "c.wav" },
          invalid: { input: 42 },
        },
        video_transcode: {
          valid: { input: "tiny.wav", output: "t.wav" },
          invalid: { input: 42 },
        },
        video_concat: {
          valid: { inputs: ["tiny.wav"], output: "cc.wav" },
          invalid: { inputs: "tiny.wav" },
        },
        audio_extract: {
          valid: { input: "tiny.wav", output: "a.wav" },
          invalid: { input: 42 },
        },
        audio_convert: {
          valid: { input: "tiny.wav", output: "a.mp3" },
          invalid: { input: 42 },
        },
        thumbnail_generate: {
          valid: { input: "tiny.wav", time: "0", output: "th.png" },
          invalid: { input: 42 },
        },
        media_compress: {
          valid: { input: "tiny.wav", crf: 28, output: "m.wav" },
          invalid: { input: 42 },
        },
      },
    });
    if (!report.passed) {
      for (const check of report.checks) {
        if (!check.passed)
          console.error("failed check:", check.name, check.detail);
      }
    }
    expect(report.passed).toBe(true);
  });
});
