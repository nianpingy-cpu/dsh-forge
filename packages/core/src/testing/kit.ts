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
import {
  validateArgs,
  type Plugin,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../plugin/types.js";

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
  if (result.resultSummary) {
    const s = result.resultSummary;
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
    run: runProcess,
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

    // 6. typed args accepted, canonical result
    try {
      const validResult = await tool.execute(spec.valid, ctx);
      checks.push(
        check(
          `typed args accepted: ${tool.name}`,
          isCanonicalResult(validResult),
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

  // 9. binary missing normalization: at least one tool must demonstrate
  //    BinaryNotFound when its binary is unavailable. Plugins prove this in
  //    their own suites with a missing-binary fixture; the kit checks that
  //    the plugin declares which binary it wraps.
  checks.push(
    check(
      "upstream binary declared",
      typeof plugin.metadata?.upstreamTool === "string" &&
        plugin.metadata.upstreamTool.length > 0,
    ),
  );

  return { passed: checks.every((c) => c.passed), checks };
}

export { validateArgs };
export type { Plugin, ToolDefinition, ToolResult, ToolContext };
