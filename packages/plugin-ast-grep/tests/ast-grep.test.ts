import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  astGrepPlugin,
  resolveSgBinary,
} from "@dsh-forge/plugin-ast-grep";
import {
  runContractSuite,
  runProcess,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/ast-grep", import.meta.url));

let workspaceRoot: string;
let ctx: ToolContext;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-astgrep-"));
  cpSync(FIXTURES, join(workspaceRoot, "fixtures"), { recursive: true });
  ctx = { workspaceRoot, run: runProcess };
});

describe("resolveSgBinary", () => {
  it("resolves the sg binary from the npm package or PATH", () => {
    const binary = resolveSgBinary();
    expect(binary).toBeTruthy();
  });
});

describe("ast_search", () => {
  it("finds pattern matches in TypeScript", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "transform($DATA, $CFG)",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    // sample.ts contains two transform(...) calls
    expect(result.summary).toMatch(/2 match/);
    expect(result.raw).toContain("transform(data, config)");
  });

  it("finds pattern matches in JavaScript", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "processData($$$ARGS)",
        language: "js",
        paths: ["fixtures/sample.js"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/2 match/);
  });

  it("finds pattern matches in Python", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "process_payload($PAYLOAD)",
        language: "py",
        paths: ["fixtures/sample.py"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/1 match/);
  });

  it("reports zero matches without failing", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "nonexistent_call($X)",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/0 match/);
  });

  it("returns a summaryBlock (documented Result contract field)", async () => {
    // The Result contract (PLUGIN_STANDARD.md) uses summaryBlock, not the
    // legacy resultSummary; renderModelFacing reads summaryBlock.
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "transform($DATA, $CFG)",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summaryBlock).toBeDefined();
    if (result.summaryBlock) {
      expect(result.summaryBlock.count).toBeGreaterThan(0);
    }
  });

  it("reports a Timeout error when the binary exceeds its timeout", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const timedOutCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: null,
        stdout: '[{"file":"a.ts","text":"x"}]',
        stderr: "",
        timedOut: true,
        aborted: false,
        truncated: false,
        durationMs: 30_000,
      }),
    };
    const result = await tool.execute(
      { pattern: "foo($X)", language: "ts", paths: ["fixtures/sample.ts"] },
      timedOutCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("Timeout");
  });

  it("rejects invalid arguments", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute({ pattern: 123 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects paths outside the workspace", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_search")!;
    const result = await tool.execute(
      {
        pattern: "foo($X)",
        language: "ts",
        paths: ["../../outside.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });
});

describe("ast_inspect", () => {
  it("returns detailed match info with ranges and meta variables", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_inspect")!;
    const result = await tool.execute(
      {
        pattern: "transform($DATA, $CFG)",
        language: "ts",
        file: "fixtures/sample.ts",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toContain("metaVariables");
    expect(result.raw).toContain("DATA");
  });
});

describe("ast_scan", () => {
  it("scans with an inline rule and reports findings as diagnostics", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_scan")!;
    const result = await tool.execute(
      {
        rule: [
          "id: no-console",
          "language: JavaScript",
          "rule:",
          "  pattern: console.log($$$)",
          "severity: warning",
        ].join("\n"),
        paths: ["fixtures/sample.js"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.length).toBe(1);
    expect(result.diagnostics?.[0]?.rule).toBe("no-console");
    expect(result.diagnostics?.[0]?.severity).toBe("warning");
    expect(result.diagnostics?.[0]?.file).toContain("sample.js");
  });

  it("normalizes an invalid rule to a tool failure", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_scan")!;
    const result = await tool.execute(
      { rule: "not: [valid yaml {{", paths: ["fixtures/sample.js"] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });
});

describe("ast_rule_test", () => {
  it("validates a rule against a fixture file", async () => {
    const tool = astGrepPlugin.tools.find((t) => t.name === "ast_rule_test")!;
    const result = await tool.execute(
      {
        rule: [
          "id: test-transform",
          "language: TypeScript",
          "rule:",
          "  pattern: transform($A, $B)",
        ].join("\n"),
        file: "fixtures/sample.ts",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/valid/i);
    expect(result.summary).toMatch(/2 match/);
  });
});

describe("ast_rewrite", () => {
  const rewriteTool = () =>
    astGrepPlugin.tools.find((t) => t.name === "ast_rewrite")!;
  // apply mutates files, so it must run under an approved permission context.
  // Built lazily (factory) because workspaceRoot is only assigned in beforeAll.
  const approvedCtx = (): ToolContext => ({
    workspaceRoot,
    run: runProcess,
    permission: { approved: true },
  });

  it("previews rewrites without modifying files", async () => {
    const file = join(workspaceRoot, "fixtures", "sample.js");
    const before = readFileSync(file, "utf8");
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "processData($$$ARGS)",
        replacement: "processDataAsync($$$ARGS)",
        language: "js",
        paths: ["fixtures/sample.js"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/\d+ change/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("applies rewrites to a workspace file (workspace-write)", async () => {
    const dir = join(workspaceRoot, "rewrite-fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "target.js");
    writeFileSync(file, "console.log('a');\nconsole.log('b');");
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "console.log($X)",
        replacement: "console.info($X)",
        language: "js",
        paths: ["rewrite-fixtures/target.js"],
      },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("console.info");
    expect(readFileSync(file, "utf8")).not.toContain("console.log");
  });

  it("denies apply without permission approval", async () => {
    const deniedCtx: ToolContext = { workspaceRoot, run: runProcess, permission: { approved: false } };
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "console.log($X)",
        replacement: "console.info($X)",
        language: "js",
        paths: ["rewrite-fixtures/target.js"],
      },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("applies with no matching pattern as a clean no-op", async () => {
    const dir = join(workspaceRoot, "rewrite-nomatch");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "n.js");
    writeFileSync(file, "tick();\ntock();");
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "console.log($X)",
        replacement: "console.info($X)",
        language: "js",
        paths: ["rewrite-nomatch/n.js"],
      },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/0 changes/);
    expect(readFileSync(file, "utf8")).toBe("tick();\ntock();");
  });

  it("apply with a failing target is not masked as a no-op", async () => {
    // sg exits 1 with empty stdout AND a non-empty stderr (ERROR: ...) when
    // a target cannot be read; this must surface as a failure, not '0 changes'.
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "tick()",
        replacement: "tock()",
        language: "js",
        paths: ["rewrite-nomatch/does-not-exist.js"],
      },
      approvedCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("rejects an empty paths array (no whole-workspace rewrite)", async () => {
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "console.log($X)",
        replacement: "console.info($X)",
        language: "js",
        paths: [],
      },
      approvedCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects paths outside the workspace", async () => {
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "foo($X)",
        replacement: "bar($X)",
        language: "ts",
        paths: ["../../outside.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an invalid AST pattern", async () => {
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "not: [valid $",
        replacement: "x",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("reports no changes when the pattern has no matches", async () => {
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "nonexistent_call($X)",
        replacement: "x",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/0 changes/);
  });

  it("rewrites across multiple files", async () => {
    const dir = join(workspaceRoot, "rewrite-multi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.js"), "tick();\ntock();");
    writeFileSync(join(dir, "b.js"), "tick();");
    const result = await rewriteTool().execute(
      {
        mode: "apply",
        pattern: "tick()",
        replacement: "tock()",
        language: "js",
        paths: ["rewrite-multi/a.js", "rewrite-multi/b.js"],
      },
      approvedCtx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.js"), "utf8")).not.toContain("tick()");
    expect(readFileSync(join(dir, "b.js"), "utf8")).not.toContain("tick()");
  });

  it("handles unicode content", async () => {
    const dir = join(workspaceRoot, "rewrite-unicode");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "u.js");
    writeFileSync(file, "greet('你好');\ngreet('世界');");
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "greet($X)",
        replacement: "sayHello($X)",
        language: "js",
        paths: ["rewrite-unicode/u.js"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/2 changes/);
  });

  it("handles Windows-style backslash paths", async () => {
    // Backslash normalization is win32-only by design; on POSIX '\' is a
    // literal filename character, so this is gated to Windows.
    if (process.platform !== "win32") return;
    const result = await rewriteTool().execute(
      {
        mode: "preview",
        pattern: "transform($DATA, $CFG)",
        replacement: "transformAsync($DATA, $CFG)",
        language: "ts",
        paths: ["fixtures\\sample.ts"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/2 changes/);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const report = await runContractSuite(astGrepPlugin, {
      workspaceRoot,
      // ast_search is the binary probe: with valid args it reaches ctx.run,
      // and the kit's mock runner simulates a missing sg binary.
      missingBinaryTool: "ast_search",
      missingBinaryToolArgs: {
        pattern: "foo($X)",
        language: "ts",
        paths: ["fixtures/sample.ts"],
      },
      toolArgs: {
        ast_search: {
          valid: { pattern: "foo($X)", language: "ts", paths: ["fixtures/sample.ts"] },
          invalid: { pattern: 42 },
        },
        ast_scan: {
          // A rule is required: `sg scan` without a project config fails, so
          // the contract-suite valid invocation must include an inline rule.
          valid: {
            rule: "id: r\nlanguage: JavaScript\nrule:\n  pattern: console.log($X)",
            paths: ["fixtures/sample.js"],
          },
          invalid: { paths: "not-an-array" },
        },
        ast_inspect: {
          valid: { pattern: "foo($X)", language: "ts", file: "fixtures/sample.ts" },
          invalid: { file: 7 },
        },
        ast_rule_test: {
          valid: {
            rule: "id: r\nlanguage: TypeScript\nrule:\n  pattern: foo($X)",
            file: "fixtures/sample.ts",
          },
          invalid: { rule: "" },
        },
        ast_rewrite: {
          // preview is read-only and safe for the contract suite's valid-args
          // execution against the real runner.
          valid: {
            mode: "preview",
            pattern: "foo($X)",
            replacement: "bar($X)",
            language: "ts",
            paths: ["fixtures/sample.ts"],
          },
          invalid: {
            mode: "preview",
            pattern: 42,
            replacement: "x",
            language: "ts",
            paths: ["fixtures/sample.ts"],
          },
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
