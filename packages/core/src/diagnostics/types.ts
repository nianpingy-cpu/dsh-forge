/**
 * Structured diagnostics and result normalization (ISSUE-005, ADR-003).
 *
 * All finding-producing tools normalize output into the shared Diagnostic
 * shape and compress large sets into a ResultSummary for the model.
 */

export type Severity = "info" | "warning" | "error" | "critical";

export interface Diagnostic {
  tool: string;
  severity: Severity;
  rule?: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  fixable?: boolean;
}

export interface RawDiagnostic {
  severity?: unknown;
  rule?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  message?: unknown;
  suggestion?: unknown;
  fixable?: unknown;
  [key: string]: unknown;
}

export interface TopIssue {
  rule?: string;
  message: string;
  severity: Severity;
  count: number;
}

export interface ResultSummary {
  tool: string;
  count: number;
  bySeverity: Record<Severity, number>;
  topIssues: TopIssue[];
  truncated: boolean;
  rawRef?: string;
}

const SEVERITY_MAP: Record<string, Severity> = {
  error: "error",
  err: "error",
  e: "error",
  warning: "warning",
  warn: "warning",
  w: "warning",
  info: "info",
  note: "info",
  hint: "info",
  i: "info",
  critical: "critical",
  fatal: "critical",
  crit: "critical",
};

/** Map a tool-specific severity to the canonical Severity; unknown fails safe to error. */
export function normalizeSeverity(input: unknown): Severity {
  if (typeof input === "string") {
    const mapped = SEVERITY_MAP[input.toLowerCase()];
    if (mapped) return mapped;
  }
  return "error";
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Normalize one raw finding; unknown fields are dropped, never crash. */
export function toDiagnostic(tool: string, raw: RawDiagnostic): Diagnostic {
  const diagnostic: Diagnostic = {
    tool,
    severity: normalizeSeverity(raw.severity),
    message: coerceString(raw.message) ?? "(no message)",
  };
  const rule = coerceString(raw.rule);
  if (rule !== undefined) diagnostic.rule = rule;
  const file = coerceString(raw.file);
  if (file !== undefined) diagnostic.file = file;
  const line = coerceNumber(raw.line);
  if (line !== undefined) diagnostic.line = line;
  const column = coerceNumber(raw.column);
  if (column !== undefined) diagnostic.column = column;
  const suggestion = coerceString(raw.suggestion);
  if (suggestion !== undefined) diagnostic.suggestion = suggestion;
  if (typeof raw.fixable === "boolean") diagnostic.fixable = raw.fixable;
  return diagnostic;
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parse CLI JSON output; malformed output is normalized to a parse error. */
export function parseJsonOutput(tool: string, text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      ok: false,
      error: `${tool}: malformed JSON output (${String(err)})`,
    };
  }
}

const DEFAULT_TOP_N = 5;

/**
 * Compress a diagnostic set into a model-facing summary:
 * counts by severity, top issues, truncation flag, raw reference.
 */
export function summarizeDiagnostics(
  tool: string,
  diagnostics: readonly Diagnostic[],
  options?: { topN?: number; rawRef?: string },
): ResultSummary {
  const topN = options?.topN ?? DEFAULT_TOP_N;
  const bySeverity: Record<Severity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  const issueGroups = new Map<string, TopIssue>();

  for (const d of diagnostics) {
    bySeverity[d.severity] += 1;
    const key = `${d.severity}|${d.rule ?? ""}|${d.message}`;
    const existing = issueGroups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      issueGroups.set(key, {
        rule: d.rule,
        message: d.message,
        severity: d.severity,
        count: 1,
      });
    }
  }

  const topIssues = [...issueGroups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    tool,
    count: diagnostics.length,
    bySeverity,
    topIssues,
    truncated: diagnostics.length > topN,
    rawRef: options?.rawRef,
  };
}
