import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
        args: ["-e", "console.log(process.argv[1])", String(validated.value.message)],
        cwd: ctx.workspaceRoot,
      });
      if (result.error?.code === "BinaryNotFound") {
        return {
          ok: false,
          summary: "binary missing",
          error: { code: "BinaryNotFound", message: result.error.message },
        };
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
    async execute(args, ctx) {
      const validated = validateArgs(this.inputSchema, args);
      if (!validated.ok) {
        return invalidArgs(validated.error);
      }
      const result = await ctx.run({
        binary: "dsh-forge-missing-binary-xyz",
        args: [],
        cwd: ctx.workspaceRoot,
      });
      return {
        ok: false,
        summary: "binary missing",
        error:
          result.error?.code === "BinaryNotFound"
            ? { code: "BinaryNotFound", message: result.error.message }
            : { code: "ToolFailure", message: "unknown" },
      };
    },
  };
}

function brokenBinaryTool(): ToolDefinition {
  return {
    name: "probe_broken",
    description: "Fails binary detection by returning ToolFailure",
    mutationClass: "read",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: false,
        summary: "something went wrong",
        error: {
          code: "ToolFailure",
          message: "did not detect the missing binary",
        },
      };
    },
  };
}

function goodPlugin(): Plugin {
  return {
    metadata: {
      name: "@dsh-forge/fixture-good",
      version: "0.2.0",
      upstreamTool: "node",
      coreContractVersion: "0.2.0",
      capabilities: ["echo"],
    },
    tools: [echoTool(), missingBinaryTool()],
  };
}

/** A realistic plugin tool: runs an installed binary via ctx.run and maps
 * BinaryNotFound. A real plugin wrapping an installed binary looks like this,
 * and it must be able to pass the binary-missing check when the kit injects a
 * mock runner that simulates a missing binary. */
function realProbeTool(): ToolDefinition {
  return {
    name: "probe_real",
    description: "Runs its real upstream binary; maps BinaryNotFound",
    mutationClass: "read",
    inputSchema: { type: "object", properties: {} },
    async execute(args, ctx) {
      const validated = validateArgs(this.inputSchema, args);
      if (!validated.ok) {
        return invalidArgs(validated.error);
      }
      const result = await ctx.run({
        binary: NODE,
        args: ["-e", "0"],
        cwd: ctx.workspaceRoot,
      });
      if (result.error?.code === "BinaryNotFound") {
        return {
          ok: false,
          summary: "binary missing",
          error: { code: "BinaryNotFound", message: result.error.message },
        };
      }
      return {
        ok: result.exitCode === 0,
        summary: "probe ok",
        raw: result.stdout,
      };
    },
  };
}

/** A stub that returns BinaryNotFound WITHOUT ever invoking ctx.run — this is
 * not real binary detection and must be rejected by the kit. */
function stubBinaryTool(): ToolDefinition {
  return {
    name: "probe_stub",
    description: "Hardcodes BinaryNotFound without running a binary",
    mutationClass: "read",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: false,
        summary: "binary missing",
        error: { code: "BinaryNotFound", message: "hardcoded" },
      };
    },
  };
}

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

describe("package export surface", () => {
  it("validateArgs has a single source of truth (plugin/types, not kit)", () => {
    // Under native ESM a value star-exported from two modules via the same
    // binding is silently deduped, so a runtime import test cannot detect a
    // duplicate. The published artifact must expose validateArgs exactly once
    // (index.ts already exports it via ./plugin/types.js); kit.ts must NOT
    // value re-export it, otherwise bundlers/TS consumers can hit ambiguous
    // export errors.
    const kitPath = fileURLToPath(
      new URL("../src/testing/kit.ts", import.meta.url),
    );
    const kitSource = readFileSync(kitPath, "utf8");
    expect(kitSource).not.toMatch(/export\s*\{\s*validateArgs\b/);
  });
});

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

  it("renders the documented summaryBlock field (PLUGIN_STANDARD.md)", () => {
    const text = renderModelFacing({
      ok: false,
      summary: "3 findings",
      summaryBlock: {
        tool: "ruff",
        count: 3,
        bySeverity: { error: 1, warning: 2, info: 0, critical: 0 },
        truncated: false,
        topIssues: [
          {
            count: 2,
            severity: "warning",
            rule: "E501",
            message: "line too long",
          },
          {
            count: 1,
            severity: "error",
            rule: "F401",
            message: "unused import",
          },
        ],
      },
    });
    expect(text).toContain("findings: 3");
    expect(text).toContain("E501");
    expect(text).toContain("[warning]");
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
      missingBinaryTool: "probe_missing",
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
      missingBinaryTool: "probe_missing",
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
      missingBinaryTool: "probe_missing",
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
      missingBinaryTool: "probe_missing",
      toolArgs: {
        echo_lenient: { valid: { message: "x" }, invalid: { message: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /invalid args/i.test(c.name)),
    ).toBe(true);
  });

  it("fails when a plugin's binary-missing tool does not return BinaryNotFound", async () => {
    // The kit must detect a plugin that fails to implement binary detection
    // (e.g. returns ToolFailure instead of BinaryNotFound).
    const plugin: Plugin = {
      metadata: { ...goodPlugin().metadata },
      tools: [echoTool(), brokenBinaryTool()],
    };
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      missingBinaryTool: "probe_broken",
      toolArgs: {
        echo_message: { valid: { message: "x" }, invalid: {} },
        probe_broken: { valid: {}, invalid: { x: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /binary-missing/i.test(c.name)),
    ).toBe(true);
  });

  it("fails when a tool returns ok:false for valid arguments", async () => {
    // "typed args accepted" must be actually enforced: a stub that always
    // returns a normalized failure for valid args is a non-functional tool
    // and must not pass the kit.
    const stub: ToolDefinition = {
      ...echoTool(),
      name: "echo_stub",
      async execute() {
        return {
          ok: false,
          summary: "stub",
          error: { code: "ToolFailure", message: "stub" },
        };
      },
    };
    const plugin: Plugin = {
      metadata: { ...goodPlugin().metadata },
      tools: [stub, missingBinaryTool()],
    };
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      missingBinaryTool: "probe_missing",
      toolArgs: {
        echo_stub: { valid: { message: "x" }, invalid: {} },
        probe_missing: { valid: {}, invalid: { x: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /typed args accepted/i.test(c.name)),
    ).toBe(true);
  });

  it("passes binary-missing check for a real tool via the injected mock runner", async () => {
    // A realistic tool that runs an installed binary and maps BinaryNotFound
    // must pass when the kit injects a mock runner simulating a missing
    // binary — the check must not be limited to synthetic nonexistent-binary
    // fixtures.
    const plugin: Plugin = {
      metadata: { ...goodPlugin().metadata },
      tools: [realProbeTool()],
    };
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      missingBinaryTool: "probe_real",
      toolArgs: {
        probe_real: { valid: {}, invalid: { x: 1 } },
      },
    });
    expect(report.passed).toBe(true);
  });

  it("fails binary-missing check when a tool hardcodes BinaryNotFound without running its binary", async () => {
    // Returning BinaryNotFound without ever invoking ctx.run is not real
    // binary detection and must not pass the check.
    const plugin: Plugin = {
      metadata: { ...goodPlugin().metadata },
      tools: [stubBinaryTool()],
    };
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      missingBinaryTool: "probe_stub",
      toolArgs: {
        probe_stub: { valid: {}, invalid: { x: 1 } },
      },
    });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some((c) => !c.passed && /binary-missing/i.test(c.name)),
    ).toBe(true);
  });

  it("passes binary-missing check when the probe tool requires args (missingBinaryToolArgs)", async () => {
    // Real plugin tools usually require arguments before they reach ctx.run;
    // the kit must let the plugin supply the probe invocation args so the
    // binary-missing check is passable by real plugins.
    const plugin: Plugin = {
      metadata: { ...goodPlugin().metadata },
      tools: [echoTool()],
    };
    const report = await runContractSuite(plugin, {
      workspaceRoot,
      missingBinaryTool: "echo_message",
      missingBinaryToolArgs: { message: "probe" },
      toolArgs: {
        echo_message: { valid: { message: "x" }, invalid: { message: 1 } },
      },
    });
    expect(report.passed).toBe(true);
  });
});
