import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync } from "node:fs";
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
