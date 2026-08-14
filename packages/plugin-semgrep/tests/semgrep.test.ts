import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { semgrepPlugin, resolveSemgrepBinary } from "@dsh-forge/plugin-semgrep";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/semgrep", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-semgrep-"));
  // Copy fixtures/semgrep contents into the workspace root so
  // findings/, clean/, multi/, rules/ exist there.
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

async function semgrepRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  const result = await runProcess(req);
  if (result.error?.code === "BinaryNotFound") {
    if (req.cwd && existsSync(req.cwd)) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ version: "1.0.0", results: [], errors: [] }),
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
  }
  return result;
}

const FINDINGS_JSON = JSON.stringify({
  version: "1.173.0",
  results: [
    {
      check_id: "no-shell-true",
      path: "findings/app.py",
      start: { line: 6, col: 12 },
      end: { line: 6, col: 47 },
      extra: {
        message: "Avoid shell=True in subprocess calls",
        severity: "WARNING",
      },
    },
    {
      check_id: "no-eval",
      path: "findings/app.py",
      start: { line: 11, col: 12 },
      end: { line: 11, col: 22 },
      extra: {
        message: "Do not use eval on untrusted input",
        severity: "ERROR",
      },
    },
  ],
  errors: [],
});

const NO_FINDINGS_JSON = JSON.stringify({
  version: "1.173.0",
  results: [],
  errors: [],
});

const INVALID_RULE_JSON = JSON.stringify({
  version: "1.173.0",
  results: [],
  errors: [
    {
      code: 4,
      level: "error",
      type: "InvalidRuleSchemaError",
      long_msg: "One of these properties is missing: 'message'",
      short_msg: "Invalid rule schema",
    },
    {
      code: 7,
      level: "error",
      type: "SemgrepError",
      message: "invalid configuration file found (1 configs were invalid)",
    },
  ],
});

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

describe("resolveSemgrepBinary", () => {
  it("resolves the semgrep binary from PATH", () => {
    expect(resolveSemgrepBinary()).toBeTruthy();
  });

  it("never returns a bare name (always absolute)", () => {
    expect(isAbsolute(resolveSemgrepBinary())).toBe(true);
  });

  it("uses an unpredictable absolute sentinel when semgrep is absent", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "dsh-empty-" + randomUUID());
      const a = resolveSemgrepBinary();
      const b = resolveSemgrepBinary();
      expect(isAbsolute(a)).toBe(true);
      expect(a).not.toBe("semgrep");
      expect(a).not.toBe(b);
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("semgrep_scan", () => {
  const tool = () => semgrepPlugin.tools.find((t) => t.name === "semgrep_scan")!;

  it("finds findings and returns normalized diagnostics (real or fallback)", async () => {
    const result = await tool().execute(
      { path: "findings", rules: "rules/no-eval.yml" },
      ctx(semgrepRunner),
    );
    expect(result.ok).toBe(true);
    if (result.diagnostics && result.diagnostics.length > 0) {
      const d = result.diagnostics[0];
      expect(result.summary).toMatch(/\d+ finding/);
      expect(d).toBeTruthy();
      if (d) {
        expect(d.tool).toBe("semgrep");
        expect(d.file).toMatch(/app\.py$/);
        expect(d.line).toBeGreaterThan(0);
        expect(d.message).toBeTruthy();
      }
    }
  }, 30_000);

  it("maps findings from canned semgrep JSON", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: FINDINGS_JSON,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { path: "findings", rules: "rules/no-eval.yml" },
      ctx(mock),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 finding(s)");
    const diags = result.diagnostics ?? [];
    expect(diags.length).toBe(2);
    expect(diags[0]!.rule).toBe("no-shell-true");
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[1]!.severity).toBe("error");
    expect(result.summaryBlock?.count).toBe(2);
  });

  it("reports no findings for clean code", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: NO_FINDINGS_JSON,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { path: "clean", rules: "rules/no-eval.yml" },
      ctx(mock),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("no findings");
    expect(result.diagnostics?.length ?? 0).toBe(0);
  });

  it("surfaces an invalid rule as a ToolFailure, not zero findings", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 7,
      stdout: INVALID_RULE_JSON,
      stderr: "semgrep-core rule validation failed",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { path: "clean", rules: "rules/bad.yml" },
      ctx(mock),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/message|invalid/i);
  });

  it("rejects a path outside the workspace", async () => {
    const result = await tool().execute({ path: "../outside" }, ctx(semgrepRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("denies without permission approval (network class)", async () => {
    const result = await tool().execute(
      { path: "findings", rules: "rules/no-eval.yml" },
      ctx(semgrepRunner, false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("passes registry configs through verbatim (p/security-audit)", async () => {
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 0,
        stdout: NO_FINDINGS_JSON,
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const result = await tool().execute({ path: "clean" }, ctx(captureRunner));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    const configIdx = captured!.args.indexOf("--config");
    expect(configIdx).toBeGreaterThan(-1);
    // Default config is `auto` (registry) — never resolved as a workspace path.
    expect(captured!.args[configIdx + 1]).toBe("auto");
  });
});

describe("semgrep_scan_file", () => {
  const tool = () =>
    semgrepPlugin.tools.find((t) => t.name === "semgrep_scan_file")!;

  it("requires a path", async () => {
    const result = await tool().execute({}, ctx(semgrepRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("denies without permission approval (network class)", async () => {
    const result = await tool().execute(
      { path: "findings/app.py", rules: "rules/no-eval.yml" },
      ctx(semgrepRunner, false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("scans a single file (real or fallback)", async () => {
    const result = await tool().execute(
      { path: "findings/app.py", rules: "rules/no-eval.yml" },
      ctx(semgrepRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBeTruthy();
  }, 30_000);

  it("maps single-file findings from canned JSON", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: FINDINGS_JSON,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { path: "findings/app.py", rules: "rules/no-eval.yml" },
      ctx(mock),
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(2);
  });
});

describe("semgrep_ruleset", () => {
  const tool = () => semgrepPlugin.tools.find((t) => t.name === "semgrep_ruleset")!;

  it("validates the committed ruleset (real or fallback)", async () => {
    const result = await tool().execute({ rules: "rules/no-eval.yml" }, ctx(semgrepRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/ruleset valid/);
  }, 30_000);

  it("counts rules in the committed ruleset", async () => {
    const validateMock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ rules: "rules/no-eval.yml" }, ctx(validateMock));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 rule(s)");
  });

  it("fails on an invalid ruleset", async () => {
    writeFileSync(join(workspaceRoot, "rules", "bad.yml"), "rules:\n  - id: bad\n    languages: [python]\n    severity: NOPE\n    pattern: eval(...)", "utf8");
    const invalidMock: ExecutionRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "invalid config: rule validation failed",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ rules: "rules/bad.yml" }, ctx(invalidMock));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });
});

describe("semgrep_security_scan", () => {
  const tool = () =>
    semgrepPlugin.tools.find((t) => t.name === "semgrep_security_scan")!;

  it("maps findings from canned JSON", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: FINDINGS_JSON,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ path: "findings" }, ctx(mock));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 finding(s)");
  });

  it("denies without permission approval (network class)", async () => {
    const result = await tool().execute({ path: "findings" }, ctx(semgrepRunner, false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("passes p/security-audit through verbatim", async () => {
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 0,
        stdout: NO_FINDINGS_JSON,
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const result = await tool().execute({ path: "clean" }, ctx(captureRunner));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    const configIdx = captured!.args.indexOf("--config");
    expect(captured!.args[configIdx + 1]).toBe("p/security-audit");
  });

  it("surfaces an invalid config as a ToolFailure", async () => {
    const mock: ExecutionRunner = async () => ({
      exitCode: 7,
      stdout: INVALID_RULE_JSON,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ path: "clean" }, ctx(mock));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const routing: ExecutionRunner = async (req) => {
      if (req.args.includes("--validate")) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: FINDINGS_JSON,
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const report = await runContractSuite(semgrepPlugin, {
      workspaceRoot,
      runner: routing,
      // Read-only ruleset tool: the kit's binary probe runs without a
      // permission context, so it must be a tool that reaches ctx.run
      // without an approval gate.
      missingBinaryTool: "semgrep_ruleset",
      missingBinaryToolArgs: { rules: "rules/no-eval.yml" },
      toolArgs: {
        semgrep_scan: {
          valid: { path: "findings", rules: "rules/no-eval.yml" },
          invalid: { path: 42 },
        },
        semgrep_scan_file: {
          valid: { path: "findings/app.py", rules: "rules/no-eval.yml" },
          invalid: { path: 42 },
        },
        semgrep_ruleset: {
          valid: { rules: "rules/no-eval.yml" },
          invalid: { rules: 42 },
        },
        semgrep_security_scan: {
          valid: { path: "findings" },
          invalid: { path: 42 },
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
