/**
 * ast-grep read adapter (ISSUE-009).
 *
 * Typed tools compiled to sg argv[] — no shell, no free-form commands.
 * All tools are read-only (MutationClass: read).
 */
import {
  validateArgs,
  parseJsonOutput,
  toDiagnostic,
  summarizeDiagnostics,
  resolveInWorkspace,
  WorkspaceViolationError,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type Diagnostic,
} from "@dsh-forge/core";
import { resolveSgBinary, SG_BINARY_HINT } from "./binary.js";

const LANGUAGES = ["js", "jsx", "ts", "tsx", "py"] as const;

interface SgMatch {
  text?: string;
  file?: string;
  range?: { start?: { line?: number; column?: number } };
  language?: string;
  metaVariables?: unknown;
}

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
    summary: `ast-grep binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: SG_BINARY_HINT },
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
    summary: "ast-grep failed",
    error: { code: "ToolFailure", message },
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

function matchesToDiagnostics(
  workspaceRoot: string,
  matches: readonly SgMatch[],
  rule?: string,
): Diagnostic[] {
  return matches.map((m) =>
    toDiagnostic("ast-grep", {
      severity: "info",
      rule,
      file: toRelativeFile(workspaceRoot, m.file),
      line: (m.range?.start?.line ?? 0) + 1,
      column: (m.range?.start?.column ?? 0) + 1,
      message: `match: ${m.text ?? "(empty)"}`,
    }),
  );
}

async function runSg(
  ctx: ToolContext,
  args: readonly string[],
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; result: ToolResult }> {
  const binary = resolveSgBinary() ?? "sg";
  const execution = await ctx.run({
    binary,
    args,
    cwd: ctx.workspaceRoot,
    timeoutMs: 30_000,
  });
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  if (execution.exitCode !== 0) {
    // sg uses grep-like exit codes: 1 = no matches, with valid JSON on
    // stdout. Only treat as failure when there is no parseable payload.
    const head = execution.stdout.trimStart()[0];
    if (head !== "[" && head !== "{") {
      const firstLine =
        execution.stderr.trim().split("\n").find((l) => l.startsWith("Error:")) ??
        execution.stderr.trim().split("\n")[0] ??
        `exit code ${execution.exitCode}`;
      return { ok: false, result: toolFailure(firstLine) };
    }
  }
  return { ok: true, stdout: execution.stdout, stderr: execution.stderr };
}

/**
 * Persist an inline rule to a temp file outside the workspace (sg --rule
 * requires a path). The user's code is never touched; the file is removed
 * after the run.
 */
async function withRuleFile(
  rule: string,
  fn: (rulePath: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dsh-sg-rule-"));
  const rulePath = join(dir, "rule.yml");
  try {
    writeFileSync(rulePath, rule, "utf8");
    return await fn(rulePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- ast_search

const astSearch: ToolDefinition = {
  name: "ast_search",
  description:
    "Search code by AST pattern (ast-grep). Supports js/jsx/ts/tsx/py. Patterns use $VAR (single node) and $$$VAR (multi node) meta variables.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "AST pattern, e.g. foo($X, $Y)" },
      language: { type: "string", enum: LANGUAGES, description: "target language" },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "workspace-relative files/directories to search",
      },
    },
    required: ["pattern", "language", "paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { pattern, language, paths } = validated.value as {
      pattern: string;
      language: string;
      paths: string[];
    };

    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;

    const run = await runSg(ctx, [
      "run",
      "-p",
      pattern,
      "-l",
      language,
      "--json=pretty",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;

    const parsed = parseJsonOutput("ast-grep", run.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        summary: "ast-grep produced malformed output",
        error: { code: "ParseFailure", message: parsed.error },
      };
    }
    const matches = Array.isArray(parsed.value) ? (parsed.value as SgMatch[]) : [];
    const diagnostics = matchesToDiagnostics(ctx.workspaceRoot, matches, pattern);
    return {
      ok: true,
      summary: `${matches.length} match${matches.length === 1 ? "" : "es"} for pattern in ${paths.length} path(s)`,
      diagnostics,
      resultSummary: summarizeDiagnostics("ast-grep", diagnostics, { topN: 5 }),
      raw: run.stdout.length > 20_000 ? run.stdout.slice(0, 20_000) + "\n...[truncated]" : run.stdout,
    };
  },
};

// -------------------------------------------------------------- ast_inspect

const astInspect: ToolDefinition = {
  name: "ast_inspect",
  description:
    "Inspect detailed AST match info (ranges, meta variables) for one pattern in one file.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      language: { type: "string", enum: LANGUAGES },
      file: { type: "string", description: "workspace-relative file" },
    },
    required: ["pattern", "language", "file"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { pattern, language, file } = validated.value as {
      pattern: string;
      language: string;
      file: string;
    };

    const safe = safePaths(ctx.workspaceRoot, [file]);
    if (!safe.ok) return safe.result;

    const run = await runSg(ctx, [
      "run",
      "-p",
      pattern,
      "-l",
      language,
      "--json=pretty",
      ...safe.absolute,
    ]);
    if (!run.ok) return run.result;

    const parsed = parseJsonOutput("ast-grep", run.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        summary: "ast-grep produced malformed output",
        error: { code: "ParseFailure", message: parsed.error },
      };
    }
    const matches = Array.isArray(parsed.value) ? (parsed.value as SgMatch[]) : [];
    return {
      ok: true,
      summary: `${matches.length} detailed match${matches.length === 1 ? "" : "es"} in ${file}`,
      raw: run.stdout.length > 40_000 ? run.stdout.slice(0, 40_000) + "\n...[truncated]" : run.stdout,
    };
  },
};

// ----------------------------------------------------------------- ast_scan

const astScan: ToolDefinition = {
  name: "ast_scan",
  description:
    "Scan with an ast-grep YAML rule (inline string). Returns normalized diagnostics. Read-only.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      rule: {
        type: "string",
        description: "inline ast-grep rule YAML (optional: omit to use project rules)",
      },
      paths: { type: "array", items: { type: "string" } },
    },
    required: ["paths"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { rule, paths } = validated.value as { rule?: string; paths: string[] };

    const safe = safePaths(ctx.workspaceRoot, paths);
    if (!safe.ok) return safe.result;

    const scanWithRule = async (rulePath?: string): Promise<ToolResult> => {
      const ruleArgs = rulePath !== undefined ? ["--rule", rulePath] : [];
      const run = await runSg(ctx, [
        "scan",
        ...ruleArgs,
        "--json=pretty",
        ...safe.absolute,
      ]);
      if (!run.ok) return run.result;

      const parsed = parseJsonOutput("ast-grep", run.stdout);
      if (!parsed.ok) {
        return {
          ok: false,
          summary: "ast-grep produced malformed output",
          error: { code: "ParseFailure", message: parsed.error },
        };
      }
      const rawFindings = Array.isArray(parsed.value)
        ? (parsed.value as Record<string, unknown>[])
        : [];
      const diagnostics = rawFindings.map((f) =>
        toDiagnostic("ast-grep", {
          severity: typeof f.severity === "string" ? f.severity : "warning",
          rule: f.ruleId ?? f.rule_id,
          file: toRelativeFile(
            ctx.workspaceRoot,
            typeof f.file === "string" ? f.file : undefined,
          ),
          line:
            typeof (f.range as { start?: { line?: number } } | undefined)?.start?.line ===
            "number"
              ? ((f.range as { start?: { line?: number } }).start?.line ?? 0) + 1
              : undefined,
          message: typeof f.message === "string" ? f.message : "scan finding",
        }),
      );
      return {
        ok: true,
        summary: `${diagnostics.length} finding${diagnostics.length === 1 ? "" : "s"}`,
        diagnostics,
        summaryBlock: summarizeDiagnostics("ast-grep", diagnostics, { topN: 5 }),
        raw:
          run.stdout.length > 20_000
            ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
            : run.stdout,
      };
    };

    if (rule !== undefined) {
      return withRuleFile(rule, scanWithRule);
    }
    return scanWithRule();
  },
};

// ------------------------------------------------------------ ast_rule_test

const astRuleTest: ToolDefinition = {
  name: "ast_rule_test",
  description:
    "Test an inline ast-grep YAML rule against one file; reports whether the rule is valid and how many matches it produces.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      rule: { type: "string", description: "inline ast-grep rule YAML" },
      file: { type: "string", description: "workspace-relative fixture file" },
    },
    required: ["rule", "file"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { rule, file } = validated.value as { rule: string; file: string };

    const safe = safePaths(ctx.workspaceRoot, [file]);
    if (!safe.ok) return safe.result;

    return withRuleFile(rule, async (rulePath) => {
      const run = await runSg(ctx, [
        "scan",
        "--rule",
        rulePath,
        "--json=pretty",
        ...safe.absolute,
      ]);
      if (!run.ok) return run.result;

      const parsed = parseJsonOutput("ast-grep", run.stdout);
      if (!parsed.ok) {
        return {
          ok: false,
          summary: "ast-grep produced malformed output",
          error: { code: "ParseFailure", message: parsed.error },
        };
      }
      const matches = Array.isArray(parsed.value) ? (parsed.value as SgMatch[]) : [];
      return {
        ok: true,
        summary: `rule valid; ${matches.length} match${matches.length === 1 ? "" : "es"} in ${file}`,
        raw:
          run.stdout.length > 20_000
            ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
            : run.stdout,
      };
    });
  },
};

export const astGrepPlugin = {
  metadata: {
    name: "@dsh-forge/plugin-ast-grep",
    version: "0.1.0",
    upstreamTool: "ast-grep",
    coreContractVersion: "0.1.0",
    capabilities: ["ast-search:js", "ast-search:ts", "ast-search:py", "scan", "inspect", "rule-test"],
  },
  tools: [astSearch, astInspect, astScan, astRuleTest],
};

export { resolveSgBinary };
