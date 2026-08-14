/**
 * Plugin contract test kit (ISSUE-007).
 *
 * Every plugin package runs its plugin through runContractSuite to prove:
 * load, registration, schema validity, typed args accepted, invalid args
 * rejected, canonical results, model-facing rendering, permission
 * classification, and binary-missing normalization.
 */
import { CORE_VERSION } from "../index.js";
import { runProcess } from "../process/runner.js";
import type { ExecutionRequest, ExecutionResult } from "../process/runner.js";
import type { PermissionContext } from "../workspace/policy.js";
import {
  type Plugin,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../plugin/types.js";

/** Signature of the core process runner, injectable for deterministic tests. */
export type ExecutionRunner = (
  request: ExecutionRequest,
) => Promise<ExecutionResult>;

export interface ContractCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ContractReport {
  passed: boolean;
  checks: ContractCheck[];
}

export interface ToolArgsSpec {
  valid: unknown;
  invalid: unknown;
}

export interface ContractSuiteOptions {
  workspaceRoot: string;
  /**
   * Name of a tool that must return BinaryNotFound when its binary is
   * absent. The kit runs it against a mock runner that reports BinaryNotFound
   * and asserts the tool (a) actually invoked ctx.run and (b) mapped the
   * runner condition to the normalized BinaryNotFound error — so a plugin
   * that fails to implement binary detection is caught, and real plugins
   * wrapping installed binaries can pass deterministically.
   */
  missingBinaryTool: string;
  /**
   * Arguments to invoke the missing-binary probe with (defaults to {}). Real
   * plugin tools usually require arguments before they reach ctx.run, so
   * plugins supply the probe invocation here.
   */
  missingBinaryToolArgs?: unknown;
  /**
   * Override the process runner used for the tool execution checks (defaults
   * to the real runProcess). Plugins may inject a mock to test tools without
   * depending on real binaries/environment.
   */
  runner?: ExecutionRunner;
  /**
   * Permission context used for execution checks. Defaults to approved
   * (`{ approved: true }`) so workspace-write tools (which gate on
   * `ctx.permission`) can be exercised end-to-end by the kit; the denial
   * path is verified by each plugin's own tests.
   */
  permission?: PermissionContext;
  /** Per-tool valid/invalid argument samples used by execution checks. */
  toolArgs: Record<string, ToolArgsSpec>;
}

function check(name: string, passed: boolean, detail?: string): ContractCheck {
  return { name, passed, detail };
}

/** Render a compact model-facing text block for a ToolResult. */
export function renderModelFacing(result: ToolResult): string {
  const lines: string[] = [];
  lines.push(result.ok ? "OK" : "FAILED");
  lines.push(result.summary);
  if (result.error) {
    lines.push(`error: ${result.error.code}: ${result.error.message}`);
  }
  if (result.summaryBlock) {
    const s = result.summaryBlock;
    lines.push(
      `findings: ${s.count} (error=${s.bySeverity.error}, warning=${s.bySeverity.warning}, info=${s.bySeverity.info}, critical=${s.bySeverity.critical})${s.truncated ? " [truncated]" : ""}`,
    );
    for (const issue of s.topIssues.slice(0, 5)) {
      lines.push(
        `  ${issue.count}x [${issue.severity}] ${issue.rule ?? "no-rule"}: ${issue.message}`,
      );
    }
  } else if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics.slice(0, 5)) {
      const loc = d.file
        ? ` ${d.file}${d.line !== undefined ? `:${d.line}` : ""}`
        : "";
      lines.push(
        `[${d.severity}] ${d.rule ?? "no-rule"}${loc}: ${d.message}`,
      );
    }
    if (result.diagnostics.length > 5) {
      lines.push(`  ...and ${result.diagnostics.length - 5} more`);
    }
  }
  return lines.join("\n");
}

function isCanonicalResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return typeof r.ok === "boolean" && typeof r.summary === "string";
}

/** Run the full contract suite against a plugin. */
export async function runContractSuite(
  plugin: Plugin,
  options: ContractSuiteOptions,
): Promise<ContractReport> {
  const checks: ContractCheck[] = [];
  const ctx: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    run: options.runner ?? runProcess,
    permission: options.permission ?? { approved: true },
  };

  // 1. plugin loads
  checks.push(
    check(
      "plugin loads",
      typeof plugin === "object" &&
        plugin !== null &&
        typeof plugin.metadata?.name === "string" &&
        Array.isArray(plugin.tools),
    ),
  );

  // 2. core contract version matches
  checks.push(
    check(
      "core contract version matches CORE_VERSION",
      plugin.metadata?.coreContractVersion === CORE_VERSION,
      `plugin declares ${String(plugin.metadata?.coreContractVersion)}, core is ${CORE_VERSION}`,
    ),
  );

  // 3. tool names unique and non-empty
  const names = plugin.tools.map((t) => t.name);
  const unique = new Set(names);
  checks.push(
    check(
      "tool names are unique and non-empty",
      names.length === unique.size && names.every((n) => n.length > 0),
    ),
  );

  for (const tool of plugin.tools) {
    const spec = options.toolArgs[tool.name];
    // The designated binary probe's contract is to return BinaryNotFound, so
    // it is exempt from the "valid args succeed" execution checks (it is
    // exercised by check 9 instead).
    const isBinaryProbe = tool.name === options.missingBinaryTool;

    // 4. schema valid
    const schemaOk =
      tool.inputSchema?.type === "object" &&
      typeof tool.inputSchema?.properties === "object";
    checks.push(check(`schema valid: ${tool.name}`, schemaOk));

    // 5. permission classification declared
    checks.push(
      check(
        `permission class declared: ${tool.name}`,
        [
          "read",
          "workspace-write",
          "network",
          "process",
          "system-change",
          "destructive",
        ].includes(tool.mutationClass),
      ),
    );

    if (!spec) {
      checks.push(
        check(
          `args spec provided: ${tool.name}`,
          false,
          "no toolArgs entry for this tool",
        ),
      );
      continue;
    }

    // 6. typed args accepted: the tool must actually succeed (ok:true) on a
    //    valid invocation. A stub that always returns a normalized failure
    //    for valid args is a non-functional tool and must not pass.
    if (!isBinaryProbe) {
      try {
        const validResult = await tool.execute(spec.valid, ctx);
        const accepted =
          isCanonicalResult(validResult) && validResult.ok === true;
        checks.push(
          check(
            `typed args accepted: ${tool.name}`,
            accepted,
            `got ok=${String(validResult.ok)}, error=${String(validResult.error?.code)}`,
          ),
        );
        checks.push(
          check(
            `canonical result: ${tool.name}`,
            isCanonicalResult(validResult) &&
              (validResult.ok || validResult.error !== undefined),
          ),
        );
        // 7. model-facing render
        const rendered = renderModelFacing(validResult);
        checks.push(
          check(
            `model-facing render: ${tool.name}`,
            typeof rendered === "string" && rendered.length > 0,
          ),
        );
      } catch (err) {
        checks.push(
          check(
            `typed args accepted: ${tool.name}`,
            false,
            `threw: ${String(err)}`,
          ),
        );
      }
    }

    // 8. invalid args rejected with InvalidArguments
    try {
      const invalidResult = await tool.execute(spec.invalid, ctx);
      checks.push(
        check(
          `invalid args rejected: ${tool.name}`,
          invalidResult.ok === false &&
            invalidResult.error?.code === "InvalidArguments",
          `got ok=${String(invalidResult.ok)}, error=${String(invalidResult.error?.code)}`,
        ),
      );
    } catch (err) {
      checks.push(
        check(
          `invalid args rejected: ${tool.name}`,
          false,
          `threw instead of returning normalized error: ${String(err)}`,
        ),
      );
    }
  }

  // 9. binary-missing path returns BinaryNotFound. The kit runs the
  //    designated probe tool against a MOCK runner that reports
  //    BinaryNotFound for every request, and asserts that the tool
  //    (a) actually invoked ctx.run (proving it executes binaries through
  //    the runner rather than hardcoding the error) and (b) mapped the
  //    runner's condition to the normalized BinaryNotFound error. This is
  //    deterministic for real plugins wrapping installed binaries and still
  //    catches plugins that fail to implement binary detection.
  const probe = plugin.tools.find((t) => t.name === options.missingBinaryTool);
  if (!probe) {
    checks.push(
      check(
        "binary-missing path returns BinaryNotFound",
        false,
        `no tool named "${options.missingBinaryTool}" in the plugin`,
      ),
    );
  } else {
    let runnerInvoked = false;
    const missingBinaryCtx: ToolContext = {
      workspaceRoot: options.workspaceRoot,
      run: async (request) => {
        runnerInvoked = true;
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 0,
          error: {
            code: "BinaryNotFound",
            message: `mock runner: binary not found: ${request.binary}`,
          },
        };
      },
    };
    try {
      const probeResult = await probe.execute(
        options.missingBinaryToolArgs ?? {},
        missingBinaryCtx,
      );
      const detected =
        runnerInvoked &&
        probeResult.ok === false &&
        probeResult.error?.code === "BinaryNotFound";
      checks.push(
        check(
          "binary-missing path returns BinaryNotFound",
          detected,
          runnerInvoked
            ? `got ok=${String(probeResult.ok)}, error=${String(probeResult.error?.code)}`
            : "tool never invoked ctx.run (hardcoded result, not real binary detection)",
        ),
      );
    } catch (err) {
      checks.push(
        check(
          "binary-missing path returns BinaryNotFound",
          false,
          `threw instead of returning normalized error: ${String(err)}`,
        ),
      );
    }
  }

  // 10. the plugin declares which upstream binary it wraps.
  checks.push(
    check(
      "upstream binary declared",
      typeof plugin.metadata?.upstreamTool === "string" &&
        plugin.metadata.upstreamTool.length > 0,
    ),
  );

  return { passed: checks.every((c) => c.passed), checks };
}

export type { Plugin, ToolDefinition, ToolResult, ToolContext };
// Note: `validateArgs` is deliberately NOT re-exported here. index.ts already
// exposes it via `export * from "./plugin/types.js"`; a second value
// re-export from this module would create an ambiguous `export *` name in the
// package namespace for consumers (bundlers / strict TS / native ESM).
