import { describe, expect, it } from "vitest";
import {
  normalizeSeverity,
  toDiagnostic,
  summarizeDiagnostics,
  parseJsonOutput,
} from "@dsh-forge/core";

describe("normalizeSeverity", () => {
  it.each([
    ["error", "error"],
    ["Error", "error"],
    ["err", "error"],
    ["warning", "warning"],
    ["warn", "warning"],
    ["W", "warning"],
    ["info", "info"],
    ["note", "info"],
    ["hint", "info"],
    ["critical", "critical"],
    ["fatal", "critical"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeSeverity(input)).toBe(expected);
  });

  it("maps unknown severity to error (fail-safe)", () => {
    expect(normalizeSeverity("bizarre")).toBe("error");
    expect(normalizeSeverity(undefined)).toBe("error");
  });
});

describe("toDiagnostic", () => {
  it("maps file, line, and column fields", () => {
    const d = toDiagnostic("ruff", {
      severity: "warning",
      rule: "F401",
      file: "src/a.py",
      line: 12,
      column: 3,
      message: "unused import",
    });
    expect(d).toEqual({
      tool: "ruff",
      severity: "warning",
      rule: "F401",
      file: "src/a.py",
      line: 12,
      column: 3,
      message: "unused import",
    });
  });

  it("drops unknown fields instead of crashing", () => {
    const d = toDiagnostic("biome", {
      severity: "error",
      message: "syntax error",
      mysteryField: { deep: [1, 2, 3] },
      another: "x",
    });
    expect(d.tool).toBe("biome");
    expect(d.message).toBe("syntax error");
    expect(Object.keys(d)).not.toContain("mysteryField");
  });

  it("coerces string line/column numbers", () => {
    const d = toDiagnostic("semgrep", {
      severity: "error",
      message: "finding",
      line: "42",
      column: "7",
    });
    expect(d.line).toBe(42);
    expect(d.column).toBe(7);
  });

  it("rejects non-numeric line values by dropping them", () => {
    const d = toDiagnostic("semgrep", {
      severity: "error",
      message: "finding",
      line: "not-a-number",
    });
    expect(d.line).toBeUndefined();
  });
});

describe("parseJsonOutput", () => {
  it("parses valid JSON", () => {
    const result = parseJsonOutput("ruff", '{"results": []}');
    expect(result.ok).toBe(true);
  });

  it("normalizes malformed output to a parse error", () => {
    const result = parseJsonOutput("ruff", "not json at all {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ruff/);
  });
});

describe("summarizeDiagnostics", () => {
  it("summarizes a large diagnostic set with counts, top issues, and truncation", () => {
    const diagnostics = Array.from({ length: 500 }, (_, i) =>
      toDiagnostic("ruff", {
        severity: i % 10 === 0 ? "error" : "warning",
        rule: i % 3 === 0 ? "F401" : "E501",
        file: `src/file${i % 40}.py`,
        line: i,
        message: i % 3 === 0 ? "unused import" : "line too long",
      }),
    );
    const summary = summarizeDiagnostics("ruff", diagnostics, {
      topN: 2,
      rawRef: "raw://run-1",
    });
    expect(summary.count).toBe(500);
    expect(summary.bySeverity.error).toBe(50);
    expect(summary.bySeverity.warning).toBe(450);
    expect(summary.topIssues.length).toBe(2);
    expect(summary.truncated).toBe(true);
    expect(summary.rawRef).toBe("raw://run-1");
    // top issues sorted by count descending
    expect(summary.topIssues[0]?.count).toBeGreaterThanOrEqual(
      summary.topIssues[1]?.count ?? 0,
    );
  });

  it("does not flag truncation for small sets", () => {
    const diagnostics = [
      toDiagnostic("biome", { severity: "error", message: "one" }),
    ];
    const summary = summarizeDiagnostics("biome", diagnostics);
    expect(summary.count).toBe(1);
    expect(summary.truncated).toBe(false);
    expect(summary.topIssues.length).toBe(1);
  });
});
