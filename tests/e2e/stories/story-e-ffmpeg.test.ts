import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runProcess, type ToolContext } from "@dsh-forge/core";
import { ffmpegPlugin, resolveFfmpegBinary } from "@dsh-forge/plugin-ffmpeg";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/ffmpeg", import.meta.url),
);

const tool = (name: string) =>
  ffmpegPlugin.tools.find((t) => t.name === name)!;

const ctx = (workspaceRoot: string): ToolContext => ({
  workspaceRoot,
  run: runProcess,
  permission: { approved: true },
});

let workspaceRoot: string;

let hasRealFfmpeg = false;
try {
  hasRealFfmpeg = statSync(resolveFfmpegBinary()).isFile();
} catch {
  // not installed
}

// Story E: video -> probe -> clip -> verify the clip with a second probe.
describe.skipIf(!hasRealFfmpeg)("story E: video -> probe -> clip -> verify", () => {
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-e-"));
    cpSync(FIXTURES, workspaceRoot, { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it(
    "probes the source video, clips it, and probes the clip to verify",
    async () => {
      const probed = await tool("media_probe").execute(
        { input: "tiny.mp4" },
        ctx(workspaceRoot),
      );
      expect(probed.ok, probed.error?.message).toBe(true);
      expect(probed.raw).toMatch(/h264/);

      const clipped = await tool("video_clip").execute(
        { input: "tiny.mp4", start: "0", duration: "0.5", output: "clip.mp4" },
        ctx(workspaceRoot),
      );
      expect(clipped.ok, clipped.error?.message).toBe(true);

      const verified = await tool("media_probe").execute(
        { input: "clip.mp4" },
        ctx(workspaceRoot),
      );
      expect(verified.ok, verified.error?.message).toBe(true);
      expect(verified.raw).toMatch(/h264/);
    },
    120_000,
  );
});
