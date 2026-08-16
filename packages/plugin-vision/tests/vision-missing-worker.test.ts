/**
 * Real-runner BinaryNotFound for a genuinely absent worker (ISSUE-062 review
 * round 2). `resolveVisionWorker` is mocked to return a non-existent absolute
 * path so each tool runs against a truly missing worker through the REAL
 * process runner and must normalize to BinaryNotFound (Plugin Standard rule 4:
 * missing binary => BinaryNotFound, never a bare-name exec or a ParseFailure
 * from empty node output).
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtempSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ToolContext,
} from "@dsh-forge/core";

// Mock the internal binary module BEFORE importing the plugin so the worker
// resolves to a non-existent absolute path.
vi.mock("../src/binary.js", () => ({
  resolveVisionWorker: () =>
    join(tmpdir(), `dsh-vision-absent-${Date.now()}`, "vision-worker.mjs"),
  VISION_WORKER_HINT: "test hint: worker is intentionally absent",
}));

import { visionPlugin } from "@dsh-forge/plugin-vision";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/vision", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-vision-missing-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

function realRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  return runProcess(req);
}

const ctx = (): ToolContext => ({
  workspaceRoot,
  run: realRunner,
  permission: { approved: true },
});

describe("absent worker (real runner)", () => {
  it("vision_inspect returns BinaryNotFound when the worker is absent", async () => {
    const inspect = visionPlugin.tools.find(
      (t) => t.name === "vision_inspect",
    )!;
    const result = await inspect.execute({ input: "sales.csv" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("data_analyze returns BinaryNotFound when the worker is absent", async () => {
    const analyze = visionPlugin.tools.find((t) => t.name === "data_analyze")!;
    const result = await analyze.execute({ data: "sales.csv" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("chart_generate returns BinaryNotFound when the worker is absent", async () => {
    const chart = visionPlugin.tools.find((t) => t.name === "chart_generate")!;
    const result = await chart.execute(
      { series: [{ label: "A", value: 1 }], type: "bar", output: "o.svg" },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });
});
