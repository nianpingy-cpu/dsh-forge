import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("docs/PLUGIN_STANDARD.md contract consistency (regression from PR #32 review)", () => {
  const doc = readFileSync(
    fileURLToPath(new URL("../docs/PLUGIN_STANDARD.md", import.meta.url)),
    "utf8",
  );

  it("documents the ToolResult field as resultSummary (not summaryBlock)", () => {
    expect(doc).toContain("resultSummary");
    expect(doc).not.toContain("summaryBlock");
  });

  it("documents the Diagnostic severity set used by the contract kit", () => {
    expect(doc).toMatch(/info/);
    expect(doc).toMatch(/warning/);
    expect(doc).toMatch(/error/);
    expect(doc).toMatch(/critical/);
  });
});
