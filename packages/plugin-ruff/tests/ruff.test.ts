import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ruffPlugin,
  resolveRuffBinary,
} from "@dsh-forge/plugin-ruff";
import {
  runContractSuite,
  runProcess,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/ruff", import.meta.url));

let workspaceRoot: string;
let ctx: ToolContext;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-ruff-"));
  cpSync(FIXTURES, join(workspaceRoot, "fixtures"), { recursive: true });
  ctx = { workspaceRoot, run: runProcess };
});

describe("resolveRuffBinary", () => {
  it("resolves the ruff binary from PATH", () => {
    const binary = resolveRuffBinary();
    expect(binary).toBeTruthy();
  });
});

describe("ruff_check", () => {
  const tool = () =>
    ruffPlugin.tools.find((t) => t.name === "ruff_check")!;

  it("finds violations and normalizes them to diagnostics", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(2);
    expect(result.summary).toMatch(/2 finding/);
    const f401s = (result.diagnostics ?? []).filter((d) => d.rule === "F401");
    expect(f401s.length).toBe(2);
    expect(f401s[0]?.file).toContain("sample.py");
    expect(f401s[0]?.line).toBe(1);
    expect(f401s[0]?.fixable).toBe(true);
    expect(f401s[0]?.severity).toBe("error");
  });

  it("reports no findings for a clean file", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/clean.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length ?? 0).toBe(0);
    expect(result.summary).toMatch(/no findings/);
  });

  it("returns a summaryBlock for findings", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summaryBlock).toBeDefined();
    expect(result.summaryBlock?.count).toBe(2);
  });

  it("normalizes malformed JSON to a parse failure", async () => {
    const badCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 0,
        stdout: "not json {",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      }),
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      badCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("treats a non-array JSON payload as a parse failure", async () => {
    // A syntactically valid object (e.g. an error payload) must never be
    // silently reported as zero findings.
    const objectCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 0,
        stdout: '{"error":"something broke"}',
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      }),
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      objectCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("surfaces truncated output as a cap error, not a parse failure", async () => {
    // A truncated stream must never be misreported as malformed JSON.
    const truncatedCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 0,
        stdout: "[{",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: true,
        durationMs: 1,
      }),
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      truncatedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/output cap/);
  });

  it("rejects an empty path entry", async () => {
    const result = await tool().execute({ paths: [""] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("reports BinaryNotFound when the binary is missing", async () => {
    const missingCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 0,
        error: { code: "BinaryNotFound", message: "ruff not found" },
      }),
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      missingCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("rejects invalid arguments", async () => {
    const result = await tool().execute({ paths: "not-an-array" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects paths outside the workspace", async () => {
    const result = await tool().execute(
      { paths: ["../../outside.py"] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("handles Windows-style backslash paths", async () => {
    // Backslash normalization is win32-only by design.
    if (process.platform !== "win32") return;
    const result = await tool().execute(
      { paths: ["fixtures\\sample.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(2);
  });
});

describe("ruff_format_check", () => {
  const tool = () =>
    ruffPlugin.tools.find((t) => t.name === "ruff_format_check")!;

  it("reports files that would be reformatted", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(1);
    expect(result.diagnostics?.[0]?.rule).toBe("unformatted");
    expect(result.diagnostics?.[0]?.file).toContain("unformatted.py");
  });

  it("reports already-formatted files as clean", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/formatted.py"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length ?? 0).toBe(0);
    expect(result.summary).toMatch(/formatted/);
  });
});

describe("ruff_explain", () => {
  const tool = () =>
    ruffPlugin.tools.find((t) => t.name === "ruff_explain")!;

  it("returns rule summary and explanation", async () => {
    const result = await tool().execute({ code: "E501" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("E501");
    expect(result.summary).toMatch(/line-too-long/i);
    expect(result.raw).toMatch(/## What it does/);
  });

  it("rejects an invalid rule code", async () => {
    const result = await tool().execute({ code: "NOT_A_RULE" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("rejects an empty code", async () => {
    const result = await tool().execute({ code: "" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects a leading-dash code (flag injection)", async () => {
    const result = await tool().execute({ code: "--config" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });
});

describe("ruff_fix", () => {
  const tool = () => ruffPlugin.tools.find((t) => t.name === "ruff_fix")!;
  const approvedCtx = (): ToolContext => ({
    workspaceRoot,
    run: runProcess,
    permission: { approved: true },
  });

  it("applies safe fixes to a file (workspace-write)", async () => {
    const dir = join(workspaceRoot, "fix-fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "fixme.py");
    writeFileSync(
      file,
      "import os\nimport sys\n\ndef add(a, b):\n    return a + b\n",
    );
    const result = await tool().execute(
      { paths: ["fix-fixtures/fixme.py"] },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).not.toContain("import os");
    expect(content).not.toContain("import sys");
  });

  it("denies without permission approval", async () => {
    const deniedCtx: ToolContext = {
      workspaceRoot,
      run: runProcess,
      permission: { approved: false },
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("leaves unfixable findings in place", async () => {
    const dir = join(workspaceRoot, "fix-unfixable");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "broken.py");
    writeFileSync(
      file,
      "def add(a, b):\n    return a + undefined_helper(b)\n",
    );
    const result = await tool().execute(
      { paths: ["fix-unfixable/broken.py"] },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("undefined_helper");
    const remaining = result.diagnostics ?? [];
    expect(remaining.some((d) => d.rule === "F821")).toBe(true);
  });

  it("blocks fix when a matched file escapes the workspace (symlink escape)", async () => {
    const outsideFile = join(workspaceRoot, "..", `outside-fix-${Date.now()}.py`);
    let applied = false;
    const mockCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async (req) => {
        // Probe (no --fix) reports a match in an outside file.
        if (!req.args.includes("--fix")) {
          return {
            exitCode: 1,
            stdout: JSON.stringify([
              { code: "F401", filename: outsideFile, location: { row: 1, column: 1 } },
            ]),
            stderr: "",
            timedOut: false,
            aborted: false,
            truncated: false,
            durationMs: 1,
          };
        }
        applied = true;
        return {
          exitCode: 0,
          stdout: "[]",
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.py"] },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
    expect(applied).toBe(false);
  });
});

describe("ruff_format", () => {
  const tool = () => ruffPlugin.tools.find((t) => t.name === "ruff_format")!;
  const approvedCtx = (): ToolContext => ({
    workspaceRoot,
    run: runProcess,
    permission: { approved: true },
  });

  it("formats files in place (workspace-write)", async () => {
    const dir = join(workspaceRoot, "fmt-fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "messy.py");
    writeFileSync(file, "def add(a,b):\n    return a+b\n");
    const result = await tool().execute(
      { paths: ["fmt-fixtures/messy.py"] },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("a + b");
  });

  it("denies without permission approval", async () => {
    const deniedCtx: ToolContext = {
      workspaceRoot,
      run: runProcess,
      permission: { approved: false },
    };
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.py"] },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("blocks format when a matched file escapes the workspace (symlink escape)", async () => {
    const outsideFile = join(workspaceRoot, "..", `outside-fmt-${Date.now()}.py`);
    let applied = false;
    const mockCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async (req) => {
        // Probe (format --check) reports the outside file as unformatted.
        if (req.args.includes("--check")) {
          return {
            exitCode: 1,
            stdout: JSON.stringify([
              { code: "unformatted", filename: outsideFile, location: { row: 1, column: 1 } },
            ]),
            stderr: "",
            timedOut: false,
            aborted: false,
            truncated: false,
            durationMs: 1,
          };
        }
        applied = true;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    };
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.py"] },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
    expect(applied).toBe(false);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const report = await runContractSuite(ruffPlugin, {
      workspaceRoot,
      // ruff_check is the binary probe: with valid args it reaches ctx.run,
      // and the kit's mock runner simulates a missing ruff binary.
      missingBinaryTool: "ruff_check",
      missingBinaryToolArgs: { paths: ["fixtures/sample.py"] },
      toolArgs: {
        ruff_check: {
          valid: { paths: ["fixtures/sample.py"] },
          invalid: { paths: 42 },
        },
        ruff_format_check: {
          valid: { paths: ["fixtures/formatted.py"] },
          invalid: { paths: 42 },
        },
        ruff_explain: {
          valid: { code: "E501" },
          invalid: { code: "" },
        },
        ruff_fix: {
          valid: { paths: ["fixtures/sample.py"] },
          invalid: { paths: 42 },
        },
        ruff_format: {
          valid: { paths: ["fixtures/formatted.py"] },
          invalid: { paths: 42 },
        },
      },
    });
    if (!report.passed) {
      for (const check of report.checks) {
        if (!check.passed) console.error("failed check:", check.name, check.detail);
      }
    }
    expect(report.passed).toBe(true);
  });
});
