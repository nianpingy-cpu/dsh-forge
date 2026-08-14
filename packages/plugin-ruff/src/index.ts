/**
 * Ruff read/write adapter (ISSUE-011).
 *
 * Typed tools compiled to ruff argv[] — no shell, no free-form commands.
 * Read tools: ruff_check, ruff_format_check, ruff_explain.
 * Write tools: ruff_fix, ruff_format (workspace-write, permission-gated).
 * All machine-readable output is parsed as Ruff JSON, never terminal regex.
 */
import {
  validateArgs,
  parseJsonOutput,
  toDiagnostic,
  summarizeDiagnostics,
  normalizeSeverity,
  resolveInWorkspace,
  WorkspaceViolationError,
  assertPermission,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type Diagnostic,
} from "@dsh-forge/core";
import { resolveRuffBinary, RUFF_BINARY_HINT } from "./binary.js";

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
    summary: `ruff binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: RUFF_BINARY_HINT },
  };
}

function workspaceViolation(target: string): ToolResult {
  return {
    ok: false,
    summary: "path escapes the workspace boundary",
    error: { code: "WorkspaceViolation", message: `rejected: ${target}` },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "ruff failed",
    error: { code: "ToolFailure", message },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message:
        "this tool is a workspace-write mutation and requires permission approval",
    },
  };
}

/** Resolve workspace-relative paths through the boundary check. */
function safePaths(
  workspaceRoot: string,
  paths: readonly string[],
): { ok: true; absolute: string[] } | { ok: false; result: ToolResult } {
  const absolute: string[] = [];
  for (const p of paths) {
    try {
      absolute.push(resolveInWorkspace(workspaceRoot, p));
    } catch (err) {
      if (err instanceof WorkspaceViolationError) {
        return { ok: false, result: workspaceViolation(p) };
      }
      throw err;
    }
  }
  return { ok: true, absolute };
}

function toRelativeFile(workspaceRoot: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  return file.startsWith(workspaceRoot) ? file.slice(workspaceRoot.length + 1) : file;
}

interface RuffEntry {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  severity?: unknown;
  filename?: unknown;
  location?: { row?: unknown; column?: unknown };
  fix?: { message?: unknown } | null;
}

/** Normalize a ruff JSON finding into a core Diagnostic. */
function ruffEntryToDiagnostic(workspaceRoot: string, e: RuffEntry): Diagnostic {
  return toDiagnostic("ruff", {
    severity: normalizeSeverity(e.severity),
    rule: typeof e.code === "string" ? e.code : undefined,
    file: toRelativeFile(
      workspaceRoot,
      typeof e.filename === "string" ? e.filename : undefined,
    ),
    line: e.location?.row,
    column: e.location?.column,
    message: typeof e.message === "string" ? e.message : "(no message)",
    suggestion: typeof e.fix?.message === "string" ? e.fix.message : undefined,
    fixable: Boolean(e.fix),
  });
}

async function runRuff(
  ctx: ToolContext,
  args: readonly string[],
): Promise<
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; result: ToolResult }
> {
  const binary = resolveRuffBinary() ?? "ruff";
  const execution = await ctx.run({
    binary,
    args,
    cwd: ctx.workspaceRoot,
    timeoutMs: 30_000,
  });
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (execution.timedOut || execution.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "ruff timed out",
        error: {
          code: "Timeout",
          message: `ruff exceeded the ${execution.durationMs}ms execution timeout`,
        },
      },
    };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  // ruff uses grep-like exit codes for check/format --check: 0 = clean,
  // 1 = findings present (JSON still on stdout). Anything else is a real
  // error (bad args, invalid rule, unreadable file).
  if (execution.exitCode !== 0 && execution.exitCode !== 1) {
    const firstLine =
      execution.stderr.trim().split("\n").find((l) => l.startsWith("error")) ??
      execution.stderr.trim().split("\n")[0] ??
      `exit code ${execution.exitCode}`;
    return { ok: false, result: toolFailure(firstLine) };
  }
  return {
    ok: true,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode ?? 0,
  };
}

/** Ensure every resolved target exists (rewriting/linting nonexistent paths is an input error). */
async function requireExisting(
  absolute: readonly string[],
): Promise<ToolResult | null> {
  const { existsSync } = await import("node:fs");
  for (const p of absolute) {
    if (!existsSync(p)) {
      return invalid(`path does not exist: ${p}`);
    }
  }
  return null;
}

function parseRuffJson(run: { ok: true; stdout: string }): {
  ok: true;
  entries: RuffEntry[];
} | { ok: false; result: ToolResult } {
  const parsed = parseJsonOutput("ruff", run.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "ruff produced malformed output",
        error: { code: "ParseFailure", message: parsed.error },
      },
    };
  }
  const entries = Array.isArray(parsed.value)
    ? (parsed.value as RuffEntry[])
    : [];
  return { ok: true, entries };
}

function resultWithDiagnostics(
  workspaceRoot: string,
  entries: RuffEntry[],
  okSummary: string,
  run: { ok: true; stdout: string },
): ToolResult {
  const diagnostics = entries.map((e) =>
    ruffEntryToDiagnostic(workspaceRoot, e),
  );
  return {
    ok: true,
    summary: okSummary,
    diagnostics,
    summaryBlock:
      diagnostics.length > 0 ? summarizeDiagnostics("ruff", diagnostics) : undefined,
    raw:
      run.stdout.length > 20_000
        ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
        : run.stdout,
  };
}

const PATH_SCHEMA = {
  type: "array" as const,
  items: { type: "string" as const },
  minItems: 1,
  description:
    "workspace-relative files or directories to check (at least one)",
};

const ruffCheck: ToolDefinition = {
  name: "ruff_check",
  description:
    "Run ruff check over Python files and return findings as normalized diagnostics (read).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      paths: PATH_SCHEMA,
      select: { type: "string", description: "comma-separated rule codes to enable" },
      ignore: { type: "string", description: "comma-separated rule codes to ignore" },
    },
    required: ["paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { paths, select, ignore } = validated.value as {
      paths: string[];
      select?: string;
      ignore?: string;
    };
    if (!Array.isArray(paths) || paths.length === 0) {
      return invalid("paths must contain at least one file or directory");
    }
    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;
    const missing = await requireExisting(safe.absolute);
    if (missing) return missing;
    const argv = ["check", "--output-format", "json"];
    if (select) argv.push("--select", select);
    if (ignore) argv.push("--ignore", ignore);
    argv.push(...safe.absolute);
    const run = await runRuff(ctx, argv);
    if (!run.ok) return run.result;
    const parsed = parseRuffJson(run);
    if (!parsed.ok) return parsed.result;
    const summary =
      parsed.entries.length === 0
        ? "no findings"
        : `${parsed.entries.length} finding${parsed.entries.length === 1 ? "" : "s"}`;
    return resultWithDiagnostics(ctx.workspaceRoot, parsed.entries, summary, run);
  },
};

const ruffFormatCheck: ToolDefinition = {
  name: "ruff_format_check",
  description:
    "Check whether Python files are formatted per ruff; files that would be reformatted are returned as diagnostics (read).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: { paths: PATH_SCHEMA },
    required: ["paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { paths } = validated.value as { paths: string[] };
    if (!Array.isArray(paths) || paths.length === 0) {
      return invalid("paths must contain at least one file or directory");
    }
    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;
    const missing = await requireExisting(safe.absolute);
    if (missing) return missing;
    const run = await runRuff(ctx, [
      "format",
      "--check",
      "--output-format",
      "json",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;
    const parsed = parseRuffJson(run);
    if (!parsed.ok) return parsed.result;
    const count = parsed.entries.length;
    const summary =
      count === 0
        ? "all files formatted"
        : `${count} file${count === 1 ? "" : "s"} would be reformatted`;
    return resultWithDiagnostics(ctx.workspaceRoot, parsed.entries, summary, run);
  },
};

const ruffExplain: ToolDefinition = {
  name: "ruff_explain",
  description:
    "Explain a ruff rule (code, summary, and full explanation) (read).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "ruff rule code, e.g. E501" },
    },
    required: ["code"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { code } = validated.value as { code: string };
    if (typeof code !== "string" || code.trim() === "") {
      return invalid("code must be a non-empty ruff rule code");
    }
    const run = await runRuff(ctx, ["rule", code, "--output-format", "json"]);
    if (!run.ok) return run.result;
    const parsed = parseJsonOutput("ruff", run.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        summary: "ruff produced malformed output",
        error: { code: "ParseFailure", message: parsed.error },
      };
    }
    const info = parsed.value as Record<string, unknown> | null;
    if (!info || typeof info !== "object") {
      return toolFailure("ruff rule returned no data for the given code");
    }
    const name = typeof info.name === "string" ? info.name : code;
    const ruleSummary = typeof info.summary === "string" ? info.summary : "";
    const explanation = typeof info.explanation === "string" ? info.explanation : "";
    return {
      ok: true,
      summary: `${name} (${code}): ${ruleSummary}`.trim(),
      raw:
        explanation.length > 20_000
          ? explanation.slice(0, 20_000) + "\n...[truncated]"
          : explanation,
    };
  },
};

const ruffFix: ToolDefinition = {
  name: "ruff_fix",
  description:
    "Apply ruff's safe auto-fixes to Python files in place (workspace-write, requires permission approval). Remaining unfixable findings are returned as diagnostics.",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      paths: PATH_SCHEMA,
      select: { type: "string", description: "comma-separated rule codes to enable" },
      ignore: { type: "string", description: "comma-separated rule codes to ignore" },
    },
    required: ["paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { paths, select, ignore } = validated.value as {
      paths: string[];
      select?: string;
      ignore?: string;
    };
    if (!Array.isArray(paths) || paths.length === 0) {
      return invalid("paths must contain at least one file or directory");
    }
    if (!assertPermission("workspace-write", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;
    const missing = await requireExisting(safe.absolute);
    if (missing) return missing;
    const argv = ["check", "--fix", "--output-format", "json"];
    if (select) argv.push("--select", select);
    if (ignore) argv.push("--ignore", ignore);
    argv.push(...safe.absolute);
    const run = await runRuff(ctx, argv);
    if (!run.ok) return run.result;
    const parsed = parseRuffJson(run);
    if (!parsed.ok) return parsed.result;
    const remaining = parsed.entries.length;
    const summary =
      remaining === 0
        ? "all auto-fixable findings fixed"
        : `${remaining} finding${remaining === 1 ? "" : "s"} remaining (unfixable or not selected)`;
    return resultWithDiagnostics(ctx.workspaceRoot, parsed.entries, summary, run);
  },
};

const ruffFormat: ToolDefinition = {
  name: "ruff_format",
  description:
    "Format Python files in place with ruff (workspace-write, requires permission approval).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: { paths: PATH_SCHEMA },
    required: ["paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { paths } = validated.value as { paths: string[] };
    if (!Array.isArray(paths) || paths.length === 0) {
      return invalid("paths must contain at least one file or directory");
    }
    if (!assertPermission("workspace-write", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;
    const missing = await requireExisting(safe.absolute);
    if (missing) return missing;
    const run = await runRuff(ctx, ["format", ...safe.absolute]);
    if (!run.ok) return run.result;
    const summary = run.stdout.trim() || "formatted";
    return {
      ok: true,
      summary,
      raw:
        run.stdout.length > 20_000
          ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
          : run.stdout,
    };
  },
};

export const ruffPlugin = {
  metadata: {
    name: "@dsh-forge/plugin-ruff",
    version: "0.1.0",
    upstreamTool: "Ruff",
    coreContractVersion: "0.1.0",
    capabilities: [
      "lint:python",
      "format-check:python",
      "rule-explain:python",
      "fix:python",
      "format:python",
    ],
  },
  tools: [ruffCheck, ruffFormatCheck, ruffExplain, ruffFix, ruffFormat],
};

export { resolveRuffBinary };
