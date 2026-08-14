/**
 * Semgrep adapter (ISSUE-016) — static analysis, read-only.
 *
 * Typed tools compiled to semgrep argv[] — no shell, no free-form commands.
 * All tools are read-only (mutationClass "read"); the v1 explicitly does NOT
 * auto-modify user code (no autofix).
 *   semgrep_scan            — scan a directory (default: workspace root)
 *   semgrep_scan_file       — scan a single file
 *   semgrep_ruleset         — validate a local ruleset file
 *   semgrep_security_scan   — security-audit scan (p/security-audit by default)
 *
 * Findings are converted from semgrep's `--json` output into core
 * Diagnostic[]. A nonzero exit (e.g. invalid rule/config) is surfaced as a
 * ToolFailure with semgrep's error message, never as a silent zero-finding.
 */
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  toDiagnostic,
  normalizeSeverity,
  parseJsonOutput,
  summarizeDiagnostics,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type Diagnostic,
} from "@dsh-forge/core";
import { resolveSemgrepBinary, SEMGREP_BINARY_HINT } from "./binary.js";

const TOOL = "semgrep";

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function binaryNotFound(binary: string): ToolResult {
  return {
    ok: false,
    summary: `semgrep binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: SEMGREP_BINARY_HINT },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "semgrep failed",
    error: { code: "ToolFailure", message },
  };
}

function parseFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "semgrep produced unparseable output",
    error: { code: "ParseFailure", message },
  };
}

function toRelativeFile(
  workspaceRoot: string,
  file: string | undefined,
): string | undefined {
  if (!file) return undefined;
  return file.startsWith(workspaceRoot)
    ? file.slice(workspaceRoot.length + 1)
    : file;
}

function resolveInsideWorkspace(
  workspaceRoot: string,
  target: string,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  try {
    const absolute = resolveInWorkspace(workspaceRoot, target);
    return { ok: true, absolute };
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: {
            code: "WorkspaceViolation",
            message: `rejected: ${target}`,
          },
        },
      };
    }
    throw err;
  }
}

/**
 * Resolve the `rules` argument: a registry config name (e.g. "auto",
 * "p/security-audit") passes through verbatim; a path-like value (contains a
 * separator or a .yml/.yaml suffix) must resolve inside the workspace.
 */
function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message:
        "this tool may perform network access (fetching Semgrep registry rules) and requires permission approval",
    },
  };
}

/**
 * Registry config identifiers semgrep understands. Everything else is treated
 * as a local path and must resolve inside the workspace (rejecting absolute
 * paths, `..` traversal, and Windows paths outside the boundary), so a
 * prompt-injected `rules` value can never make semgrep read files outside the
 * workspace (ISSUE-006 / ADR-005).
 */
const REGISTRY_CONFIG_RE =
  /^(auto|secrets|supply-chain|p\/[A-Za-z0-9._-]+|r\/[A-Za-z0-9._-]+|c\/[A-Za-z0-9._-]+|x\/[A-Za-z0-9._-]+)$/i;

/**
 * Resolve the `rules` argument. Registry identifiers (no leading dash, not
 * absolute, no `..`, no path separators other than the p//r//c//x/ prefix)
 * pass through verbatim to semgrep; every other value is treated as a local
 * path and routed through resolveInWorkspace so it stays in the workspace.
 */
function resolveRules(
  workspaceRoot: string,
  rules: string | undefined,
): { ok: true; config: string } | { ok: false; result: ToolResult } {
  if (!rules) return { ok: true, config: "auto" };
  if (typeof rules !== "string" || rules.trim() === "") {
    return { ok: false, result: invalid("rules must be a non-empty string") };
  }
  const trimmed = rules.trim();
  if (REGISTRY_CONFIG_RE.test(trimmed)) {
    return { ok: true, config: trimmed };
  }
  const resolved = resolveInsideWorkspace(workspaceRoot, trimmed);
  if (!resolved.ok) return resolved;
  return { ok: true, config: resolved.absolute };
}

async function runSemgrep(
  ctx: ToolContext,
  args: readonly string[],
): Promise<
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; result: ToolResult }
> {
  const binary = resolveSemgrepBinary();
  const execution = await ctx.run({
    binary,
    args: [...args],
    cwd: ctx.workspaceRoot,
    timeoutMs: 120_000,
    // Semgrep JSON for whole-workspace scans can be large.
    maxOutputBytes: 10 * 1024 * 1024,
  });
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (execution.timedOut || execution.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "semgrep timed out",
        error: {
          code: "Timeout",
          message: "semgrep exceeded the 120000ms execution timeout",
        },
      },
    };
  }
  if (execution.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "semgrep output exceeded the output cap",
        error: {
          code: "ToolFailure",
          message:
            "semgrep output exceeded the 10 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  return {
    ok: true,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode ?? 0,
  };
}

interface SemgrepResult {
  results: SemgrepFinding[];
  errors: SemgrepError[];
}

interface SemgrepFinding {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown; col?: unknown };
  extra?: {
    message?: unknown;
    severity?: unknown;
    fix?: unknown;
    metadata?: { cwe?: unknown; references?: unknown };
  };
}

interface SemgrepError {
  type?: unknown;
  long_msg?: unknown;
  message?: unknown;
}

/** Short rule id from semgrep's path-prefixed check_id (last dot segment). */
function ruleId(checkId: string): string | undefined {
  const last = checkId.split(".").pop();
  return last && last.trim() !== "" ? last : undefined;
}

function parseSemgrepJson(run: {
  ok: true;
  stdout: string;
}): { ok: true; data: SemgrepResult } | { ok: false; result: ToolResult } {
  const parsed = parseJsonOutput(TOOL, run.stdout);
  if (!parsed.ok) {
    return { ok: false, result: parseFailure(parsed.error) };
  }
  const data = parsed.value as Record<string, unknown>;
  if (typeof data !== "object" || data === null) {
    return { ok: false, result: parseFailure("semgrep: expected a JSON object") };
  }
  return {
    ok: true,
    data: data as unknown as SemgrepResult,
  };
}

function firstSemgrepError(data: SemgrepResult): string | undefined {
  for (const e of data.errors ?? []) {
    const msg =
      typeof e.long_msg === "string"
        ? e.long_msg
        : typeof e.message === "string"
          ? e.message
          : undefined;
    if (msg) return msg;
  }
  return undefined;
}

function semgrepToDiagnostic(
  workspaceRoot: string,
  f: SemgrepFinding,
): Diagnostic {
  return toDiagnostic(TOOL, {
    severity:
      typeof f.extra?.severity === "string"
        ? normalizeSeverity(f.extra.severity)
        : normalizeSeverity(undefined),
    rule: typeof f.check_id === "string" ? ruleId(f.check_id) : undefined,
    file: toRelativeFile(
      workspaceRoot,
      typeof f.path === "string" ? f.path : undefined,
    ),
    line: f.start?.line,
    column: f.start?.col,
    message:
      typeof f.extra?.message === "string" && f.extra.message !== ""
        ? f.extra.message
        : "finding",
    suggestion: undefined,
    fixable: false,
  });
}

/**
 * Handle a completed semgrep scan: nonzero exit -> ToolFailure (with semgrep's
 * error message from JSON when available); otherwise parse findings into
 * Diagnostics.
 */
function finishScan(
  run: { ok: true; stdout: string; stderr: string; exitCode: number },
  workspaceRoot: string,
): ToolResult {
  if (run.exitCode !== 0) {
    const parsed = parseJsonOutput(TOOL, run.stdout);
    let message: string | undefined;
    if (parsed.ok) {
      const data = parsed.value as Record<string, unknown>;
      message = firstSemgrepError(data as unknown as SemgrepResult);
    }
    message =
      message ??
      run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
      `exit code ${run.exitCode}`;
    return toolFailure(message);
  }
  const parsed = parseSemgrepJson(run);
  if (!parsed.ok) return parsed.result;
  // A scan that reported errors (e.g. a file parse error) is not silently
  // reported as zero findings.
  const firstError = firstSemgrepError(parsed.data);
  if (firstError) {
    return toolFailure(firstError);
  }
  const diagnostics = (parsed.data.results ?? []).map((f) =>
    semgrepToDiagnostic(workspaceRoot, f),
  );
  return {
    ok: true,
    summary:
      diagnostics.length > 0
        ? `${diagnostics.length} finding(s)`
        : "no findings",
    diagnostics,
    summaryBlock:
      diagnostics.length > 0
        ? summarizeDiagnostics(TOOL, diagnostics)
        : undefined,
    raw:
      run.stdout.length > 20_000
        ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
        : run.stdout,
  };
}

const PATH_SCHEMA = {
  type: "string" as const,
  description: "workspace-relative path to scan (defaults to the workspace root)",
};

const RULES_SCHEMA = {
  type: "string" as const,
  description:
    "semgrep config: a registry config (e.g. auto, p/security-audit) or a workspace-relative path to a local rule file (.yml/.yaml)",
};

const semgrepScan: ToolDefinition = {
  name: "semgrep_scan",
  description:
    "Run a Semgrep scan over a directory (default: workspace root) and return findings as normalized diagnostics. Network: the default config (`auto`) and registry configs fetch rules from the Semgrep registry (no autofix).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA, rules: RULES_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { path, rules } = validated.value as { path?: string; rules?: string };
    let target = ".";
    if (path !== undefined) {
      const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
      if (!resolved.ok) return resolved.result;
      target = resolved.absolute;
    }
    const ruleConfig = resolveRules(ctx.workspaceRoot, rules);
    if (!ruleConfig.ok) return ruleConfig.result;
    const run = await runSemgrep(ctx, [
      "scan",
      "--json",
      "--config",
      ruleConfig.config,
      target,
    ]);
    if (!run.ok) return run.result;
    return finishScan(run, ctx.workspaceRoot);
  },
};

const semgrepScanFile: ToolDefinition = {
  name: "semgrep_scan_file",
  description:
    "Run a Semgrep scan over a single file and return findings as normalized diagnostics. Network: the default config (`auto`) and registry configs fetch rules from the Semgrep registry (no autofix).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA, rules: RULES_SCHEMA },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { path, rules } = validated.value as { path: string; rules?: string };
    if (typeof path !== "string" || path === "") {
      return invalid("path must be a non-empty string");
    }
    const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
    if (!resolved.ok) return resolved.result;
    const ruleConfig = resolveRules(ctx.workspaceRoot, rules);
    if (!ruleConfig.ok) return ruleConfig.result;
    const run = await runSemgrep(ctx, [
      "scan",
      "--json",
      "--config",
      ruleConfig.config,
      resolved.absolute,
    ]);
    if (!run.ok) return run.result;
    return finishScan(run, ctx.workspaceRoot);
  },
};

const semgrepRuleset: ToolDefinition = {
  name: "semgrep_ruleset",
  description:
    "Validate a local Semgrep ruleset file (read) and report how many rules it defines.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      rules: {
        type: "string" as const,
        description: "workspace-relative path to the ruleset file (.yml/.yaml)",
      },
    },
    required: ["rules"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { rules } = validated.value as { rules: string };
    if (typeof rules !== "string" || rules === "") {
      return invalid("rules must be a non-empty string");
    }
    const resolved = resolveInsideWorkspace(ctx.workspaceRoot, rules);
    if (!resolved.ok) return resolved.result;
    const run = await runSemgrep(ctx, [
      "scan",
      "--validate",
      "--config",
      resolved.absolute,
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(resolved.absolute, "utf8");
    const count = (content.match(/^\s*-\s+id:\s*/gm) ?? []).length;
    return {
      ok: true,
      summary: `ruleset valid (${count} rule(s))`,
      raw:
        content.length > 20_000 ? content.slice(0, 20_000) + "\n...[truncated]" : content,
    };
  },
};

const semgrepSecurityScan: ToolDefinition = {
  name: "semgrep_security_scan",
  description:
    "Run a Semgrep security-audit scan (p/security-audit by default; override with a local `rules`) and return findings as normalized diagnostics. Network: fetches rules from the Semgrep registry (no autofix).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA, rules: RULES_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { path, rules } = validated.value as { path?: string; rules?: string };
    let target = ".";
    if (path !== undefined) {
      const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
      if (!resolved.ok) return resolved.result;
      target = resolved.absolute;
    }
    // Default to the registry security-audit pack; tests pass a local rule.
    const ruleConfig = resolveRules(
      ctx.workspaceRoot,
      rules ?? "p/security-audit",
    );
    if (!ruleConfig.ok) return ruleConfig.result;
    const run = await runSemgrep(ctx, [
      "scan",
      "--json",
      "--config",
      ruleConfig.config,
      target,
    ]);
    if (!run.ok) return run.result;
    return finishScan(run, ctx.workspaceRoot);
  },
};

export const semgrepPlugin: {
  metadata: {
    name: string;
    version: string;
    upstreamTool: string;
    coreContractVersion: string;
    capabilities: readonly string[];
  };
  tools: readonly ToolDefinition[];
} = {
  metadata: {
    name: "@dsh-forge/plugin-semgrep",
    version: "0.1.0",
    upstreamTool: "semgrep",
    coreContractVersion: "0.1.0",
    capabilities: [
      "scan",
      "scan-file",
      "ruleset-validate",
      "security-scan",
      "read-only",
    ],
  },
  tools: [semgrepScan, semgrepScanFile, semgrepRuleset, semgrepSecurityScan],
};

export { resolveSemgrepBinary };
