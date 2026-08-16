/**
 * Biome read/write adapter (ISSUE-012).
 *
 * Typed tools compiled to biome argv[] — no shell, no free-form commands.
 * Read tools: biome_check, biome_lint, biome_format_check.
 * Write tools: biome_fix, biome_format (workspace-write, permission-gated).
 * All machine-readable output is parsed as Biome JSON (--reporter=json).
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
import { resolveBiomeBinary, BIOME_BINARY_HINT } from "./binary.js";

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
    summary: `biome binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: BIOME_BINARY_HINT },
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
    summary: "biome failed",
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
      return {
        ok: false,
        result: invalid("paths must contain only strings"),
      };
    }
    if (p === "") {
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

interface BiomeEntry {
  severity?: unknown;
  message?: unknown;
  category?: unknown;
  location?: {
    // Verified against @biomejs/biome 2.5.8: `path` is a string. Some
    // versions/docs serialize it as `{ file, language }`; accept both.
    path?: unknown;
    start?: { line?: unknown; column?: unknown };
    span?: { start?: { line?: unknown; column?: unknown } };
  };
  // Some biome reporter versions emit position data under a top-level
  // `span`; accept that shape too.
  span?: {
    start?: { line?: unknown; column?: unknown };
  };
}

/** Extract the file path from a biome diagnostic (string or {file} shape). */
function biomeFile(e: BiomeEntry): string | undefined {
  const p = e.location?.path;
  if (typeof p === "string") return p;
  if (p && typeof p === "object") {
    const file = (p as { file?: unknown }).file;
    if (typeof file === "string") return file;
  }
  return undefined;
}

/**
 * Extract (line, column) from a biome diagnostic. Verified against
 * @biomejs/biome 2.5.8: lint diagnostics report 1-based lines under
 * `location.start`; the format diagnostic reports line 0 as a whole-file
 * sentinel (mapped to undefined). Accepts `location.start`,
 * `location.span.start`, and top-level `span.start` for schema robustness.
 */
function biomePosition(
  e: BiomeEntry,
): { line?: number; column?: number } {
  const start =
    e.location?.start ??
    e.location?.span?.start ??
    e.span?.start ??
    {};
  const rawLine =
    typeof start.line === "number" && Number.isFinite(start.line)
      ? start.line
      : undefined;
  const column =
    typeof start.column === "number" && Number.isFinite(start.column) &&
    start.column > 0
      ? start.column
      : undefined;
  return { line: rawLine !== undefined && rawLine > 0 ? rawLine : undefined, column };
}

/** Normalize a biome JSON diagnostic into a core Diagnostic. */
function biomeEntryToDiagnostic(
  workspaceRoot: string,
  e: BiomeEntry,
  severityOverride?: Severity,
): Diagnostic {
  const pos = biomePosition(e);
  return toDiagnostic("biome", {
    severity:
      severityOverride ??
      (e.severity !== undefined
        ? normalizeSeverity(e.severity)
        : normalizeSeverity(undefined)),
    rule: typeof e.category === "string" ? e.category : undefined,
    file: toRelativeFile(workspaceRoot, biomeFile(e)),
    line: pos.line,
    column: pos.column,
    message: typeof e.message === "string" ? e.message : "finding",
  });
}

async function runBiome(
  ctx: ToolContext,
  args: readonly string[],
): Promise<
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; result: ToolResult }
> {
  const resolved = resolveBiomeBinary();
  let execution;
  try {
    execution = await ctx.run({
      binary: resolved.binary,
      args: [...resolved.prefixArgs, ...args],
      cwd: ctx.workspaceRoot,
      timeoutMs: 30_000,
      // Biome JSON can be large for whole-workspace checks; raise the cap well
      // above the 1 MiB default so large-but-valid results are not truncated.
      maxOutputBytes: 10 * 1024 * 1024,
    });
  } catch (err) {
    // A rejecting runner must be normalized, never thrown out of execute.
    return {
      ok: false,
      result: toolFailure(`biome runner threw: ${String(err)}`),
    };
  }
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(resolved.binary) };
  }
  if (execution.timedOut || execution.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "biome timed out",
        error: { code: "Timeout", message: "biome exceeded the 30000ms execution timeout" },
      },
    };
  }
  if (execution.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "biome output exceeded the output cap",
        error: {
          code: "ToolFailure",
          message:
            "biome output exceeded the 10 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  // A killed process (no exit code) must not be treated as success.
  if (execution.exitCode === null) {
    return {
      ok: false,
      result: toolFailure("biome terminated without an exit code"),
    };
  }
  // biome uses exit codes 0 (clean) and 1 (findings present); anything else
  // is a real error. Note: `format --write` uses exit 1 for errors too, so
  // callers that apply writes must check exitCode themselves (see
  // biome_format).
  if (execution.exitCode !== 0 && execution.exitCode !== 1) {
    const firstLine =
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

/** Ensure every resolved target exists. */
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

/** Parse biome's reporter JSON object and extract its diagnostics array. */
function parseBiomeJson(run: { ok: true; stdout: string }): {
  ok: true;
  entries: BiomeEntry[];
} | { ok: false; result: ToolResult } {
  const parsed = parseJsonOutput("biome", run.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "biome produced malformed output",
        error: { code: "ParseFailure", message: parsed.error },
      },
    };
  }
  if (typeof parsed.value !== "object" || parsed.value === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "biome produced unexpected output",
        error: { code: "ParseFailure", message: "biome: expected a JSON object" },
      },
    };
  }
  const diagnostics = (parsed.value as Record<string, unknown>).diagnostics;
  if (!Array.isArray(diagnostics)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "biome produced unexpected output",
        error: {
          code: "ParseFailure",
          message: "biome: output is missing a diagnostics array",
        },
      },
    };
  }
  return { ok: true, entries: diagnostics as BiomeEntry[] };
}

function resultWithDiagnostics(
  workspaceRoot: string,
  entries: BiomeEntry[],
  okSummary: string,
  run: { ok: true; stdout: string },
  opts?: { fallbackSeverity?: Severity },
): ToolResult {
  const diagnostics = entries.map((e) =>
    biomeEntryToDiagnostic(workspaceRoot, e, opts?.fallbackSeverity),
  );
  return {
    ok: true,
    summary: okSummary,
    diagnostics,
    summaryBlock:
      diagnostics.length > 0 ? summarizeDiagnostics("biome", diagnostics) : undefined,
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

const biomeCheck: ToolDefinition = {
  name: "biome_check",
  description:
    "Run biome check (lint + format + imports) over JS/TS/JSX/TSX/JSON and return findings as normalized diagnostics (read).",
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
    const run = await runBiome(ctx, [
      "check",
      "--reporter=json",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;
    const parsed = parseBiomeJson(run);
    if (!parsed.ok) return parsed.result;
    const n = parsed.entries.length;
    const summary = n === 0 ? "no findings" : `${n} finding${n === 1 ? "" : "s"}`;
    return resultWithDiagnostics(ctx.workspaceRoot, parsed.entries, summary, run);
  },
};

const biomeLint: ToolDefinition = {
  name: "biome_lint",
  description:
    "Run biome lint over JS/TS/JSX/TSX files and return lint findings as normalized diagnostics (read).",
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
    const run = await runBiome(ctx, [
      "lint",
      "--reporter=json",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;
    const parsed = parseBiomeJson(run);
    if (!parsed.ok) return parsed.result;
    const n = parsed.entries.length;
    const summary = n === 0 ? "no lint findings" : `${n} lint finding${n === 1 ? "" : "s"}`;
    return resultWithDiagnostics(ctx.workspaceRoot, parsed.entries, summary, run);
  },
};

const biomeFormatCheck: ToolDefinition = {
  name: "biome_format_check",
  description:
    "Check whether JS/TS/JSX/TSX/JSON files are formatted per biome; files that would be reformatted are returned as diagnostics (read).",
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
    const run = await runBiome(ctx, [
      "format",
      "--reporter=json",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;
    const parsed = parseBiomeJson(run);
    if (!parsed.ok) return parsed.result;
    const count = parsed.entries.length;
    const summary =
      count === 0
        ? "all files formatted"
        : `${count} file${count === 1 ? "" : "s"} would be reformatted`;
    return resultWithDiagnostics(
      ctx.workspaceRoot,
      parsed.entries,
      summary,
      run,
      { fallbackSeverity: "warning" },
    );
  },
};

/**
 * Boundary-verify every file a write operation would touch (symlink-escape
 * guard, ADR-005). Returns the verified canonical file list, or a blocking
 * ToolResult.
 */
function verifyTargetFiles(
  workspaceRoot: string,
  entries: BiomeEntry[],
): { ok: true; files: string[] } | { ok: false; result: ToolResult } {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== "object") {
      return {
        ok: false,
        result: toolFailure(
          "biome returned a malformed finding; cannot verify the write target",
        ),
      };
    }
    const raw = biomeFile(e);
    if (!raw) {
      return {
        ok: false,
        result: toolFailure(
          "biome returned a finding without a file path; cannot verify the write target",
        ),
      };
    }
    try {
      const canonical = resolveInWorkspace(workspaceRoot, raw);
      // Deduplicate: biome emits one JSON entry per finding, so the same
      // file appears once per finding; the apply argv must list each file
      // exactly once.
      if (!seen.has(canonical)) {
        seen.add(canonical);
        files.push(canonical);
      }
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

/**
 * Re-validate verified targets immediately before a write (TOCTOU guard).
 * resolveInWorkspace canonicalizes the real path again, so a file swapped
 * for a symlink pointing outside the workspace since the probe is rejected
 * here, before biome touches it.
 */
function revalidateTargets(
  workspaceRoot: string,
  files: readonly string[],
): { ok: true } | { ok: false; result: ToolResult } {
  for (const f of files) {
    try {
      resolveInWorkspace(workspaceRoot, f);
    } catch (err) {
      if (err instanceof WorkspaceViolationError) {
        return {
          ok: false,
          result: {
            ok: false,
            summary: "rewrite blocked: target no longer resolves inside the workspace",
            error: { code: "WorkspaceViolation", message: err.message },
          },
        };
      }
      throw err;
    }
  }
  return { ok: true };
}

const biomeFix: ToolDefinition = {
  name: "biome_fix",
  description:
    "Apply biome's safe fixes (biome check --write) to files in place (workspace-write, requires permission approval). Remaining findings are returned as diagnostics.",
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

    // Probe (read-only) to discover the exact files biome would touch, then
    // boundary-verify each before any write (ADR-005).
    const probe = await runBiome(ctx, [
      "check",
      "--reporter=json",
      ...safe.absolute,
    ]);
    if (!probe.ok) return probe.result;
    const probeParsed = parseBiomeJson(probe);
    if (!probeParsed.ok) return probeParsed.result;
    const verified = verifyTargetFiles(ctx.workspaceRoot, probeParsed.entries);
    if (!verified.ok) return verified.result;
    if (verified.files.length === 0) {
      return { ok: true, summary: "no findings to fix", raw: "" };
    }
    // TOCTOU guard: re-validate the real paths immediately before the write.
    const revalidated = revalidateTargets(ctx.workspaceRoot, verified.files);
    if (!revalidated.ok) return revalidated.result;

    const apply = await runBiome(ctx, [
      "check",
      "--write",
      "--reporter=json",
      ...verified.files,
    ]);
    if (!apply.ok) return apply.result;
    const applyParsed = parseBiomeJson(apply);
    if (!applyParsed.ok) return applyParsed.result;
    const remaining = applyParsed.entries.length;
    const summary =
      remaining === 0
        ? "all auto-fixable findings fixed"
        : `${remaining} finding${remaining === 1 ? "" : "s"} remaining (unfixable)`;
    return resultWithDiagnostics(
      ctx.workspaceRoot,
      applyParsed.entries,
      summary,
      apply,
    );
  },
};

const biomeFormat: ToolDefinition = {
  name: "biome_format",
  description:
    "Format JS/TS/JSX/TSX/JSON files in place with biome (workspace-write, requires permission approval).",
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

    // Probe (dry-run format) to discover the exact files needing formatting,
    // then boundary-verify each before writing.
    const probe = await runBiome(ctx, [
      "format",
      "--reporter=json",
      ...safe.absolute,
    ]);
    if (!probe.ok) return probe.result;
    const probeParsed = parseBiomeJson(probe);
    if (!probeParsed.ok) return probeParsed.result;
    const verified = verifyTargetFiles(ctx.workspaceRoot, probeParsed.entries);
    if (!verified.ok) return verified.result;
    if (verified.files.length === 0) {
      return { ok: true, summary: "all files formatted", raw: "" };
    }
    // TOCTOU guard: re-validate the real paths immediately before the write.
    const revalidated = revalidateTargets(ctx.workspaceRoot, verified.files);
    if (!revalidated.ok) return revalidated.result;

    const apply = await runBiome(ctx, [
      "format",
      "--write",
      ...verified.files,
    ]);
    if (!apply.ok) return apply.result;
    // `format --write` uses exit 1 for real errors (e.g. unparseable files),
    // not 'findings present'; surface it as a failure, never 'formatted'.
    if (apply.exitCode === 1) {
      return toolFailure(
        apply.stderr.trim().split("\n")[0] || "biome format failed",
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

export const biomePlugin = {
  metadata: {
    name: "@dsh-forge/plugin-biome",
    version: "1.0.0",
    upstreamTool: "Biome",
    coreContractVersion: "1.0.0",
    capabilities: [
      "check:js",
      "check:ts",
      "check:jsx",
      "check:tsx",
      "check:json",
      "lint:js",
      "lint:ts",
      "lint:jsx",
      "lint:tsx",
      "format-check:js",
      "format-check:ts",
      "format-check:jsx",
      "format-check:tsx",
      "format-check:json",
      "fix:js",
      "fix:ts",
      "fix:jsx",
      "fix:tsx",
      "fix:json",
      "format:js",
      "format:ts",
      "format:jsx",
      "format:tsx",
      "format:json",
    ],
  },
  tools: [biomeCheck, biomeLint, biomeFormatCheck, biomeFix, biomeFormat],
};

export { resolveBiomeBinary };
