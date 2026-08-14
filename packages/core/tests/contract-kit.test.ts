import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateArgs,
  renderModelFacing,
  runContractSuite,
  type Plugin,
  type ToolDefinition,
  type ToolResult,
} from "@dsh-forge/core";

const NODE = process.execPath;

function echoTool(): ToolDefinition {
  return {
    name: "echo_message",
    description: "Echoes a message via a real subprocess",
    mutationClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "message to echo" },
      },
      required: ["message"],
    },
    async execute(args, ctx) {
      const validated = validateArgs(this.inputSchema, args);
      if (!validated.ok) {
        return invalidArgs(validated.error);
      }
      const result = await ctx.run({
        binary: NODE,
        args: ["-e", "console.log(process.argv[1])", validated.value.message],
        cwd: ctx.workspaceRoot,
      });
      if (result.error?.code === "BinaryNotFound") {
        return { ok: false, summary: "binary missing", error: result.error };
      }
      return {
        ok: result.exitCode === 0,
        summary: `echoed: ${result.stdout.trim()}`,
        raw: result.stdout,
      };
    },
  };
}

function missingBinaryTool(): ToolDefinition {
  return {
    name: "probe_missing",
    description: "Always reports BinaryNotFound",
    mutationClass: "read",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const result = await ctx.run({
        binary: "dsh-forge-missing-binary-xyz",
        args: [],
        cwd: ctx.workspaceRoot,
      });
      return {
        ok: false,
        summary: "binary missing",
        error: result.error ?? { code: "ToolFailure", message: "unknown" },
      };
    },
  };
}

function goodPlugin(): Plugin {
  return {
    metadata: {
      name: "@dsh-forge/fixture-good",
      version: "0.1.0",
      upstreamTool: "node",
      coreContractVersion: "0.1.0",
      capabilities: ["echo"],
    },
    tools: [echoTool(), missingBinaryTool()],
  };
}

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

describe("validateArgs", () => {
  const schema = echoTool().inputSchema;

  it("accepts valid typed arguments", () => {
    const result = validateArgs(schema, { message: "hi" });
    expect(result.ok).toBe(true);
  });

  it("rejects non-object arguments", () => {
    const result = validateArgs(schema, "not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = validateArgs(schema, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/message/);
  });

  it("rejects wrong-typed fields", () => {
    const result = validateArgs(schema, { message: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/message/);
  });
});

describe("renderModelFacing", () => {
  it("renders a compact model-facing summary with diagnostics", () => {
    const text = renderModelFacing({
      ok: false,
      summary: "2 findings",
      diagnostics: [
        {
          tool: "ruff",
          severity: "error",
          rule: "F401",
          file: "a.py",
          line: 1,
          message: "unused import",
        },
        {
          tool: "ruff",
          severity: "warning",
          rule: "E501",
          file: "b.py",
          line: 2,
          message: "line too long",
        },
      ],
    });
    expect(text).toContain("2 findings");
    expect(text).toContain("F401");
    expect(text).toContain("a.py:1");
    expect(text.split("\n").length).toBeLessThan(10);
  });
});

describe("runContractSuite", () => {
  let workspaceRoot: string;
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-kit-"));
  });
  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("passes for a conforming fixture plugin", async () => {
    const report = await runContractSuite(goodPlugin(), {
      workspaceRoot,
      toolArgs: {
        echo_message: { valid: { message: "hello kit" }, invalid: { message: 1 } },
        probe_missing: { valid: {}, invalid: { unexpected: true } },
      },
    });
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThan(8);
    for (const check of report.checks) {
      if (!check.passed) console.error("failed check:", check.name, check.detail);
    }
  });

  it("fails for a plugin with a duplicate tool name", async () => {
    const plugin = goodPlugin();
    plugin.tools = [echoTool(), echoTool()];
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      toolArgs: { echo_message: { valid: { message: "x" }, invalid: {} } },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /unique/i.test(c.name)),
    ).toBe(true);
  });

  it("fails for a plugin with a bad core contract version", async () => {
    const plugin = goodPlugin();
    plugin.metadata.coreContractVersion = "0.0.0-mismatch";
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      toolArgs: {
        echo_message: { valid: { message: "x" }, invalid: {} },
        probe_missing: { valid: {}, invalid: { x: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /contract version/i.test(c.name)),
    ).toBe(true);
  });

  it("fails when a tool accepts invalid arguments", async () => {
    const plugin = goodPlugin();
    const lenient: ToolDefinition = {
      ...echoTool(),
      name: "echo_lenient",
      async execute() {
        return { ok: true, summary: "accepted everything" };
      },
    };
    plugin.tools = [lenient];
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      toolArgs: {
        echo_lenient: { valid: { message: "x" }, invalid: { message: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /invalid args/i.test(c.name)),
    ).toBe(true);
  });
});
