import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  runContractSuite,
  runProcess,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";
import { qualityGatePlugin } from "@dsh-forge/plugin-quality-gate";
import { resolveRuffBinary } from "@dsh-forge/plugin-ruff";

const OK = { timedOut: false, aborted: false, truncated: false, durationMs: 1 };

// Canned per-tool outputs (shapes verified against each plugin's parser).
const RUFF_EMPTY = JSON.stringify([]);
const RUFF_FINDING = JSON.stringify([
  {
    code: "F401",
    message: "'os' imported but unused",
    filename: "/w/src/app.py",
    location: { row: 1, column: 1, end_row: 1, end_column: 5 },
    fix: null,
  },
]);
const BIOME_EMPTY = JSON.stringify({ summary: {}, diagnostics: [], command: "check" });
const BIOME_WARNING = JSON.stringify({
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
});
const SEMGREP_EMPTY = JSON.stringify({ results: [], errors: [] });
const TRIVY_EMPTY = JSON.stringify({ Results: [] });
const TRIVY_SECRET = JSON.stringify({
  Results: [
    {
      Target: "src/app.py",
      Class: "secret",
      Secrets: [
        {
          RuleID: "aws-access-key-id",
          Severity: "HIGH",
          Title: "AWS Access Key",
          StartLine: 1,
          EndLine: 1,
          Match: "AKIAFAKE",
          Layer: {},
        },
      ],
    },
  ],
});

const bnf: ExecutionRunner = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...OK,
  error: { code: "BinaryNotFound", message: "not installed" },
});

function mockRunner(overrides: Record<string, ExecutionRunner> = {}): ExecutionRunner {
  return async (req) => {
    // Key on binary + argv so both direct binaries (ruff/semgrep/trivy) and
    // node-shim-spawned binaries (biome via process.execPath) route correctly.
    const key = `${basename(req.binary)} ${req.args.join(" ")}`.toLowerCase();
    for (const [k, fn] of Object.entries(overrides)) {
      if (key.includes(k.toLowerCase())) return fn(req);
    }
    if (key.includes("biome")) return { exitCode: 0, stdout: BIOME_EMPTY, stderr: "", ...OK };
    if (key.includes("ruff")) return { exitCode: 0, stdout: RUFF_EMPTY, stderr: "", ...OK };
    if (key.includes("semgrep")) return { exitCode: 0, stdout: SEMGREP_EMPTY, stderr: "", ...OK };
    if (key.includes("trivy")) return { exitCode: 0, stdout: TRIVY_EMPTY, stderr: "", ...OK };
    return { exitCode: 0, stdout: "", stderr: "", ...OK };
  };
}

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-qg-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const gate = () => qualityGatePlugin.tools.find((t) => t.name === "quality_gate")!;

const ctx = (workspaceRoot: string, runner: ExecutionRunner): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: { approved: true },
});

describe("quality_gate (ISSUE-018)", () => {
  it("PASSES a clean python project", async () => {
    const ws = makeWorkspace({ "src/app.py": "print('hi')\n" });
    try {
      const r = await gate().execute({ path: "src" }, ctx(ws, mockRunner()));
      expect(r.ok).toBe(true);
      expect(r.summary).toMatch(/PASS/);
      expect(r.summary).not.toMatch(/FAIL/);
      expect(r.diagnostics?.length ?? 0).toBe(0);
    } finally {
      cleanup(ws);
    }
  });

  it("FAILS when the lint lane finds errors", async () => {
    const ws = makeWorkspace({ "src/app.py": "import os\n" });
    try {
      const runner = mockRunner({
        ruff: async () => ({ exitCode: 0, stdout: RUFF_FINDING, stderr: "", ...OK }),
      });
      const r = await gate().execute({ path: "src" }, ctx(ws, runner));
      expect(r.ok).toBe(true);
      expect(r.summary).toMatch(/FAIL/);
      expect(r.diagnostics!.length).toBeGreaterThan(0);
    } finally {
      cleanup(ws);
    }
  });

  it("FAILS when the security lane finds secrets", async () => {
    const ws = makeWorkspace({ "src/app.py": "x = 1\n" });
    try {
      const runner = mockRunner({
        trivy: async () => ({ exitCode: 0, stdout: TRIVY_SECRET, stderr: "", ...OK }),
      });
      const r = await gate().execute({ path: "src" }, ctx(ws, runner));
      expect(r.ok).toBe(true);
      expect(r.summary).toMatch(/FAIL/);
    } finally {
      cleanup(ws);
    }
  });

  it("honours the failOn threshold override (warning vs error)", async () => {
    const ws = makeWorkspace({ "src/index.ts": "const x: number = 1;\n" });
    try {
      const runner = mockRunner({
        biome: async () => ({ exitCode: 0, stdout: BIOME_WARNING, stderr: "", ...OK }),
      });
      const r1 = await gate().execute({ path: "src" }, ctx(ws, runner));
      expect(r1.ok).toBe(true);
      expect(r1.summary).toMatch(/PASS_WITH_WARNINGS/);

      const r2 = await gate().execute(
        { path: "src", failOn: "warning" },
        ctx(ws, runner),
      );
      expect(r2.ok).toBe(true);
      expect(r2.summary).toMatch(/FAIL/);
    } finally {
      cleanup(ws);
    }
  });

  it("skips a lane whose tool is missing instead of failing the gate", async () => {
    const ws = makeWorkspace({ "src/app.py": "x = 1\n" });
    try {
      const runner = mockRunner({ ruff: bnf });
      const r = await gate().execute({ path: "src" }, ctx(ws, runner));
      expect(r.ok).toBe(true);
      expect(r.summary).toMatch(/PASS/);
      // the raw breakdown records the skipped lane
      expect(r.raw).toContain("ruff_check");
      expect(r.raw).toMatch(/skipped/i);
    } finally {
      cleanup(ws);
    }
  });

  it("reports BinaryNotFound when every tool is missing", async () => {
    const ws = makeWorkspace({ "src/app.py": "x = 1\n" });
    try {
      const runner = mockRunner({ ruff: bnf, semgrep: bnf, trivy: bnf });
      const r = await gate().execute({ path: "src" }, ctx(ws, runner));
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("BinaryNotFound");
    } finally {
      cleanup(ws);
    }
  });

  it("passes the plugin contract suite", async () => {
    const ws = makeWorkspace({ "src/app.py": "x = 1\n" });
    try {
      const report = await runContractSuite(qualityGatePlugin, {
        workspaceRoot: ws,
        runner: mockRunner(),
        // The binary probe runs without a permission context, so it must be
        // the (ungated) read/network-composed gate itself: with no tools
        // present and no approval, every lane is skipped and the gate maps
        // that to BinaryNotFound (proving it invokes ctx.run via the lanes).
        missingBinaryTool: "quality_gate",
        missingBinaryToolArgs: { path: "src" },
        toolArgs: {
          quality_gate: {
            valid: { path: "src" },
            invalid: { failOn: "not-a-severity" },
          },
        },
      });
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed, failed.map((c) => c.name).join(", ")).toEqual([]);
    } finally {
      cleanup(ws);
    }
  });
});

describe("quality_gate live (real binary, opt-in)", () => {
  let hasRealRuff = false;
  try {
    hasRealRuff = statSync(resolveRuffBinary()).isFile();
  } catch {
    // not installed
  }

  describe.skipIf(!hasRealRuff)("real ruff lane", () => {
    it("gates a real project with a lint violation to FAIL", async () => {
      const ws = makeWorkspace({ "src/app.py": "import os\n" });
      try {
        const r = await gate().execute(
          { path: "src" },
          ctx(ws, (req) => runProcess(req)),
        );
        expect(r.ok).toBe(true);
        // Ruff reports the F401 unused import -> error -> FAIL, independent
        // of whether Semgrep/Trivy are installed or reachable.
        expect(r.summary).toMatch(/FAIL/);
        expect(r.raw).toContain("ruff_check");
      } finally {
        cleanup(ws);
      }
    }, 60_000);
  });
});
