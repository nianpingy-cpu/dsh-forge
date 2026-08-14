import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  biomePlugin,
  resolveBiomeBinary,
} from "@dsh-forge/plugin-biome";
import {
  runContractSuite,
  runProcess,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/biome", import.meta.url));

let workspaceRoot: string;
let ctx: ToolContext;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-biome-"));
  cpSync(FIXTURES, join(workspaceRoot, "fixtures"), { recursive: true });
  ctx = { workspaceRoot, run: runProcess };
});

const LANG_FILES = ["sample.js", "sample.ts", "sample.jsx", "sample.tsx", "sample.json"] as const;

describe("resolveBiomeBinary", () => {
  it("resolves the biome binary (npm shim or PATH)", () => {
    const resolved = resolveBiomeBinary();
    expect(resolved.binary).toBeTruthy();
  });
});

describe("biome_check", () => {
  const tool = () => biomePlugin.tools.find((t) => t.name === "biome_check")!;

  it("finds violations and normalizes them to diagnostics", async () => {
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, ctx);
    expect(result.ok).toBe(true);
    expect((result.diagnostics?.length ?? 0)).toBeGreaterThan(0);
    expect(result.summary).toMatch(/finding/);
    const cats = result.diagnostics!.map((d) => d.rule);
    expect(cats.some((c) => c?.includes("noUnusedVariables"))).toBe(true);
    const d = result.diagnostics![0]!;
    expect(d.file).toContain("sample.js");
    expect(d.severity).toMatch(/warning|error/);
  });

  it("reports 1-based line numbers from the real binary", async () => {
    // Verified against @biomejs/biome 2.5.8: lint diagnostics are already
    // 1-based (a first-line finding reports line 1).
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, ctx);
    expect(result.ok).toBe(true);
    const unused = (result.diagnostics ?? []).find(
      (d) => d.rule?.includes("noUnusedVariables") && d.line === 1,
    );
    expect(unused).toBeDefined(); // `const unused = 42;` is on the first line
  });

  it("handles a span-based position shape (schema fallback)", async () => {
    // Some biome reporter versions emit positions under `span` rather than
    // `location.start`; positions must not silently become undefined.
    const spanCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          summary: {},
          diagnostics: [
            {
              severity: "warning",
              message: "This variable x is unused.",
              category: "lint/correctness/noUnusedVariables",
              span: { start: { line: 1, column: 7 } },
            },
          ],
          command: "check",
        }),
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      }),
    };
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, spanCtx);
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.[0]?.line).toBe(1);
    expect(result.diagnostics?.[0]?.column).toBe(7);
  });

  it("covers all fixture languages", async () => {
    for (const f of LANG_FILES) {
      const result = await tool().execute({ paths: [`fixtures/${f}`] }, ctx);
      expect(result.ok).toBe(true);
      expect((result.diagnostics?.length ?? 0)).toBeGreaterThan(0);
      expect(result.diagnostics?.[0]?.file).toContain(f);
    }
  });

  it("reports no findings for a clean file", async () => {
    const result = await tool().execute({ paths: ["fixtures/clean.js"] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length ?? 0).toBe(0);
    expect(result.summary).toMatch(/no findings/);
  });

  it("returns a summaryBlock for findings", async () => {
    const result = await tool().execute({ paths: ["fixtures/sample.ts"] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summaryBlock).toBeDefined();
    expect((result.summaryBlock?.count ?? 0)).toBeGreaterThan(0);
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
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, badCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("treats output without a diagnostics array as a parse failure", async () => {
    const objectCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 0,
        stdout: '{"summary":{}}',
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      }),
    };
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, objectCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("surfaces truncated output as a cap error, not a parse failure", async () => {
    const truncatedCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 0,
        stdout: "{",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: true,
        durationMs: 1,
      }),
    };
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, truncatedCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/output cap/);
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
        error: { code: "BinaryNotFound", message: "biome not found" },
      }),
    };
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, missingCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("rejects invalid arguments", async () => {
    const result = await tool().execute({ paths: "not-an-array" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects paths outside the workspace", async () => {
    const result = await tool().execute({ paths: ["../../outside.ts"] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an empty path entry", async () => {
    const result = await tool().execute({ paths: [""] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects a non-string path entry (no crash)", async () => {
    const result = await tool().execute({ paths: ["fixtures/sample.js", 42] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("handles Windows-style backslash paths", async () => {
    if (process.platform !== "win32") return;
    const result = await tool().execute({ paths: ["fixtures\\sample.js"] }, ctx);
    expect(result.ok).toBe(true);
    expect((result.diagnostics?.length ?? 0)).toBeGreaterThan(0);
  });
});

describe("biome_lint", () => {
  const tool = () => biomePlugin.tools.find((t) => t.name === "biome_lint")!;

  it("reports lint findings", async () => {
    const result = await tool().execute({ paths: ["fixtures/sample.js"] }, ctx);
    expect(result.ok).toBe(true);
    expect((result.diagnostics?.length ?? 0)).toBeGreaterThan(0);
    expect(result.summary).toMatch(/lint finding/);
    expect(result.diagnostics![0]!.rule).toContain("noUnusedVariables");
  });

  it("reports no lint findings for a clean file", async () => {
    const result = await tool().execute({ paths: ["fixtures/clean.js"] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length ?? 0).toBe(0);
  });
});

describe("biome_format_check", () => {
  const tool = () =>
    biomePlugin.tools.find((t) => t.name === "biome_format_check")!;

  it("reports files that would be reformatted", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.ts"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(1);
    expect(result.diagnostics?.[0]?.rule).toBe("format");
    expect(result.diagnostics?.[0]?.file).toContain("unformatted.ts");
    expect(result.diagnostics?.[0]?.severity).toBe("warning");
  });

  it("reports formatted files as clean", async () => {
    const result = await tool().execute(
      { paths: ["fixtures/formatted.ts"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length ?? 0).toBe(0);
    expect(result.summary).toMatch(/formatted/);
  });
});

describe("biome_fix", () => {
  const tool = () => biomePlugin.tools.find((t) => t.name === "biome_fix")!;
  const approvedCtx = (): ToolContext => ({
    workspaceRoot,
    run: runProcess,
    permission: { approved: true },
  });

  it("applies safe fixes to a file (workspace-write)", async () => {
    const dir = join(workspaceRoot, "fix-fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "fixme.ts");
    writeFileSync(
      file,
      "export function add(a:number,b:number){return a+b;}\n",
    );
    const result = await tool().execute(
      { paths: ["fix-fixtures/fixme.ts"] },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("a: number");
  });

  it("denies without permission approval", async () => {
    const deniedCtx: ToolContext = {
      workspaceRoot,
      run: runProcess,
      permission: { approved: false },
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.js"] },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("blocks fix when a matched file escapes the workspace (symlink escape)", async () => {
    const outsideFile = join(workspaceRoot, "..", `outside-fix-${Date.now()}.ts`);
    let applied = false;
    const mockCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async (req) => {
        if (!req.args.includes("--write")) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              summary: {},
              diagnostics: [
                { severity: "warning", message: "x", category: "lint/correctness/noUnusedVariables", location: { path: outsideFile, start: { line: 1, column: 1 } } },
              ],
              command: "check",
            }),
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
          stdout: '{"summary":{},"diagnostics":[],"command":"check"}',
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    };
    const result = await tool().execute(
      { paths: ["fixtures/sample.js"] },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
    expect(applied).toBe(false);
  });

  it("never writes through a symlink escaping the workspace", async () => {
    // End-to-end guard (exercised on symlink-capable OSes; Windows without
    // admin/Developer Mode skips). Whether biome skips the symlink (no
    // changes) or we block it, the outside target must never be modified.
    const { symlinkSync, rmSync } = await import("node:fs");
    const escapeDir = join(workspaceRoot, "escape-symlink");
    mkdirSync(escapeDir, { recursive: true });
    const outsideDir = join(workspaceRoot, "..", `outside-target-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, "secret.ts");
    writeFileSync(secret, "const unused: number = 1;\n");
    try {
      symlinkSync(secret, join(escapeDir, "link.ts"));
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // cannot create symlinks here; skip
    }
    const result = await tool().execute(
      { paths: ["escape-symlink"] },
      approvedCtx(),
    );
    expect(readFileSync(secret, "utf8")).toBe("const unused: number = 1;\n");
    rmSync(outsideDir, { recursive: true, force: true });
    void result;
  });
});

describe("biome_format", () => {
  const tool = () => biomePlugin.tools.find((t) => t.name === "biome_format")!;
  const approvedCtx = (): ToolContext => ({
    workspaceRoot,
    run: runProcess,
    permission: { approved: true },
  });

  it("formats files in place (workspace-write)", async () => {
    const dir = join(workspaceRoot, "fmt-fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "messy.ts");
    writeFileSync(file, "export function add(a:number,b:number){return a+b;}\n");
    const result = await tool().execute(
      { paths: ["fmt-fixtures/messy.ts"] },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("a: number");
  });

  it("denies without permission approval", async () => {
    const deniedCtx: ToolContext = {
      workspaceRoot,
      run: runProcess,
      permission: { approved: false },
    };
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.ts"] },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("surfaces a format --write failure (exit 1) as a tool failure", async () => {
    // `format --write` exits 1 on real errors (unparseable files), not
    // 'findings present'; must never be reported as 'formatted'.
    const target = join(workspaceRoot, "fixtures", "unformatted.ts");
    const mockCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async (req) => {
        if (req.args.includes("--reporter=json")) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              summary: {},
              diagnostics: [
                { severity: "error", message: "would print", category: "format", location: { path: target, start: { line: 0, column: 0 } } },
              ],
              command: "format",
            }),
            stderr: "",
            timedOut: false,
            aborted: false,
            truncated: false,
            durationMs: 1,
          };
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: "ERROR: could not parse file",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    };
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.ts"] },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("treats a killed process as a tool failure", async () => {
    const killedCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 100,
      }),
    };
    const result = await tool().execute(
      { paths: ["fixtures/unformatted.ts"] },
      killedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("blocks format when a matched file escapes the workspace (symlink escape)", async () => {
    const outsideFile = join(workspaceRoot, "..", `outside-fmt-${Date.now()}.ts`);
    let applied = false;
    const mockCtx: ToolContext = {
      workspaceRoot,
      permission: { approved: true },
      run: async (req) => {
        if (req.args.includes("--reporter=json")) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              summary: {},
              diagnostics: [
                { severity: "error", message: "Formatter would have printed the following content:", category: "format", location: { path: outsideFile, start: { line: 0, column: 0 } } },
              ],
              command: "format",
            }),
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
      { paths: ["fixtures/unformatted.ts"] },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
    expect(applied).toBe(false);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const report = await runContractSuite(biomePlugin, {
      workspaceRoot,
      missingBinaryTool: "biome_check",
      missingBinaryToolArgs: { paths: ["fixtures/sample.js"] },
      toolArgs: {
        biome_check: {
          valid: { paths: ["fixtures/sample.js"] },
          invalid: { paths: 42 },
        },
        biome_lint: {
          valid: { paths: ["fixtures/sample.js"] },
          invalid: { paths: 42 },
        },
        biome_format_check: {
          valid: { paths: ["fixtures/formatted.ts"] },
          invalid: { paths: 42 },
        },
        biome_fix: {
          valid: { paths: ["fixtures/sample.js"] },
          invalid: { paths: 42 },
        },
        biome_format: {
          valid: { paths: ["fixtures/formatted.ts"] },
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
