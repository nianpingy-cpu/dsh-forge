import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runProcess, type ToolContext } from "@dsh-forge/core";
import { ruffPlugin, resolveRuffBinary } from "@dsh-forge/plugin-ruff";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/e2e/ruff-broken", import.meta.url),
);

const tool = (name: string) =>
  ruffPlugin.tools.find((t) => t.name === name)!;

const ctx = (workspaceRoot: string): ToolContext => ({
  workspaceRoot,
  run: runProcess,
  permission: { approved: true },
});

let workspaceRoot: string;

let hasRealRuff = false;
try {
  hasRealRuff = statSync(resolveRuffBinary()).isFile();
} catch {
  // not installed
}

// Story A: Python bad code -> Ruff detects -> fix -> verify clean.
describe.skipIf(!hasRealRuff)("story A: python bad code -> Ruff detect -> fix -> pass", () => {
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-a-"));
    cpSync(FIXTURES, workspaceRoot, { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("detects unused imports, fixes them, and verifies a clean pass", async () => {
    const detected = await tool("ruff_check").execute(
      { paths: ["app.py"] },
      ctx(workspaceRoot),
    );
    expect(detected.ok).toBe(true);
    expect((detected.diagnostics ?? []).length).toBeGreaterThan(0);

    const fixed = await tool("ruff_fix").execute(
      { paths: ["app.py"] },
      ctx(workspaceRoot),
    );
    expect(fixed.ok).toBe(true);

    const verify = await tool("ruff_check").execute(
      { paths: ["app.py"] },
      ctx(workspaceRoot),
    );
    expect(verify.ok).toBe(true);
    expect(verify.diagnostics?.length ?? 0).toBe(0);
    const content = readFileSync(join(workspaceRoot, "app.py"), "utf8");
    expect(content).not.toContain("import os");
  }, 60_000);
});
