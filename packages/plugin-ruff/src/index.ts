/**
 * Ruff read/write adapter (ISSUE-011).
 *
 * Typed tools compiled to ruff argv[] 鈥?no shell, no free-form commands.
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
  type Severity,
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
    if (typeof p !== "string") {
      // Core validateArgs only checks array shape/minItems, not item types;
      // a non-string entry would crash resolveInWorkspace with a TypeError.
      return {
        ok: false,
        result: invalid("paths must contain only strings"),
      };
    }
    if (p === "") {
      // An empty entry resolves to the workspace root and would silently
      // scope the operation to the whole workspace.
      return { ok: false, result: invalid("paths must not contain empty entries") };
    }
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
  // Ruff format --check JSON historically used `path`; accept it as a fallback
  // so a schema shift does not silently degrade diagnostics.
  path?: unknown;
  location?: { row?: unknown; column?: unknown };
  fix?: { message?: unknown } | null;
}

/** Normalize a ruff JSON finding into a core Diagnostic. */
function ruffEntryToDiagnostic(
  workspaceRoot: string,
  e: RuffEntry,
  severityOverride?: Severity,
): Diagnostic {
  return toDiagnostic("ruff", {
    // Some ruff outputs (format --check) report 'error' for cosmetic
    // findings; callers may override to keep them from inflating error
    // counts.
    severity:
      severityOverride ??
      (e.severity !== undefined
        ? normalizeSeverity(e.severity)
        : normalizeSeverity(undefined)),
    rule: typeof e.code === "string" ? e.code : undefined,
    file: toRelativeFile(
      workspaceRoot,
      typeof e.filename === "string"
        ? e.filename
        : typeof e.path === "string"
          ? e.path
          : undefined,
    ),
    line: e.location?.row,
    column: e.location?.column,
    message:
      typeof e.message === "string" && e.message !== ""
        ? e.message
        : "finding",
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
  const binary = resolveRuffBinary();
  const execution = await ctx.run({
    binary,
    args,
    cwd: ctx.workspaceRoot,
    timeoutMs: 30_000,
    // Ruff JSON can be large for whole-workspace lints; raise the cap well
    // above the 1 MiB default so large-but-valid results are not truncated.
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
        summary: "ruff timed out",
        error: {
          code: "Timeout",
          message: "ruff exceeded the 30000ms execution timeout",
        },
      },
    };
  }
  // A truncated stream must surface as a distinct error, never as a
  // misleading "malformed JSON" parse failure on an incomplete payload.
  if (execution.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "ruff output exceeded the output cap",
        error: {
          code: "ToolFailure",
          message:
            "ruff output exceeded the 10 MiB output cap; the result was truncated",
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
  // check / format --check / fix always emit a JSON array. A non-array
  // payload (e.g. an error object) must be a ParseFailure, never silently
  // reported as zero findings.
  if (!Array.isArray(parsed.value)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "ruff produced unexpected output",
        error: {
          code: "ParseFailure",
          message: "ruff: expected a JSON array, got " + typeof parsed.value,
        },
      },
    };
  }
  return { ok: true, entries: parsed.value as RuffEntry[] };
}

function resultWithDiagnostics(
  workspaceRoot: string,
  entries: RuffEntry[],
  okSummary: string,
  run: { ok: true; stdout: string },
  opts?: { fallbackSeverity?: Severity },
): ToolResult {
  const diagnostics = entries.map((e) =>
    ruffEntryToDiagnostic(workspaceRoot, e, opts?.fallbackSeverity),
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
    const argv = ["check", "--no-cache", "--output-format", "json"];
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
      "--no-cache",
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
    // Ruff format JSON carries no severity; 'would be reformatted' is a
    // warning, not an error.
    return resultWithDiagnostics(
      ctx.workspaceRoot,
      parsed.entries,
      summary,
      run,
      { fallbackSeverity: "warning" },
    );
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
    // A leading dash or whitespace would shift ruff's own flag parsing; only
    // plain rule codes like E501 or S101 are accepted.
    if (code.startsWith("-") || /\s/.test(code)) {
      return invalid("code must be a plain ruff rule code (e.g. E501)");
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

/**
 * Boundary-verify every file a write operation would touch. Ruff re-walks
 * directories at write time and follows symlinks, so a symlink inside the
 * workspace pointing outside must be rejected (ADR-005) before any write.
 * Returns the verified canonical file list, or a blocking ToolResult.
 */
function verifyTargetFiles(
  workspaceRoot: string,
  entries: RuffEntry[],
): { ok: true; files: string[] } | { ok: false; result: ToolResult } {
  const files: string[] = [];
  for (const e of entries) {
    const raw =
      typeof e.filename === "string"
        ? e.filename
        : typeof e.path === "string"
          ? e.path
          : undefined;
    if (!raw) {
      // A match with no file identity means we cannot vouch for what ruff
      // would write; treat it as a hard error, never a silent success.
      return {
        ok: false,
        result: toolFailure(
          "ruff returned a finding without a filename; cannot verify the write target",
        ),
      };
    }
    try {
      files.push(resolveInWorkspace(workspaceRoot, raw));
    } catch (err) {
      if (err instanceof WorkspaceViolationError) {
        return {
          ok: false,
          result: {
            ok: false,
            summary: "rewrite blocked: matched file escapes the workspace",
            error: { code: "WorkspaceViolation", message: err.message },
          },
        };
      }
      throw err;
    }
  }
  return { ok: true, files };
}

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

    // Probe (read-only, no --fix) to discover the exact files ruff would
    // touch, then boundary-verify each before any write (ADR-005).
    const probeArgs = ["check", "--no-cache", "--output-format", "json"];
    if (select) probeArgs.push("--select", select);
    if (ignore) probeArgs.push("--ignore", ignore);
    probeArgs.push(...safe.absolute);
    const probe = await runRuff(ctx, probeArgs);
    if (!probe.ok) return probe.result;
    const probeParsed = parseRuffJson(probe);
    if (!probeParsed.ok) return probeParsed.result;
    const verified = verifyTargetFiles(ctx.workspaceRoot, probeParsed.entries);
    if (!verified.ok) return verified.result;
    if (verified.files.length === 0) {
      return { ok: true, summary: "no findings to fix", raw: "" };
    }

    // Apply --fix only to the boundary-verified file list.
    const applyArgs = ["check", "--no-cache", "--fix", "--output-format", "json"];
    if (select) applyArgs.push("--select", select);
    if (ignore) applyArgs.push("--ignore", ignore);
    applyArgs.push(...verified.files);
    const apply = await runRuff(ctx, applyArgs);
    if (!apply.ok) return apply.result;
    const applyParsed = parseRuffJson(apply);
    if (!applyParsed.ok) return applyParsed.result;
    const remaining = applyParsed.entries.length;
    const summary =
      remaining === 0
        ? "all auto-fixable findings fixed"
        : `${remaining} finding${remaining === 1 ? "" : "s"} remaining (unfixable or not selected)`;
    return resultWithDiagnostics(
      ctx.workspaceRoot,
      applyParsed.entries,
      summary,
      apply,
    );
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

    // Probe with format --check (read-only) to discover the exact files
    // needing formatting, then boundary-verify each before writing.
    const probe = await runRuff(ctx, [
      "format",
      "--check",
      "--output-format",
      "json",
      ...safe.absolute,
    ]);
    if (!probe.ok) return probe.result;
    const probeParsed = parseRuffJson(probe);
    if (!probeParsed.ok) return probeParsed.result;
    const verified = verifyTargetFiles(ctx.workspaceRoot, probeParsed.entries);
    if (!verified.ok) return verified.result;
    if (verified.files.length === 0) {
      return { ok: true, summary: "all files formatted", raw: "" };
    }

    const apply = await runRuff(ctx, ["format", ...verified.files]);
    if (!apply.ok) return apply.result;
    // `ruff format` (without --check) exits 1 on errors (e.g. unparseable
    // files); runRuff's grep-style rule treats 0/1 as success, so surface
    // exit 1 explicitly as a failure here.
    if (apply.exitCode === 1) {
      return toolFailure(
        apply.stderr.trim().split("\n")[0] || "ruff format failed",
      );
    }
    const summary = apply.stdout.trim() || "formatted";
    return {
      ok: true,
      summary,
      raw:
        apply.stdout.length > 20_000
          ? apply.stdout.slice(0, 20_000) + "\n...[truncated]"
          : apply.stdout,
    };
  },
};

export const ruffPlugin = {
  metadata: {
    name: "@dsh-forge/plugin-ruff",
    version: "0.1.0",
    upstreamTool: "Ruff",
    coreContractVersion: "0.2.0",
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
