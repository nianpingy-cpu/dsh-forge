import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runProcess, type ToolContext } from "@dsh-forge/core";
import { semgrepPlugin, resolveSemgrepBinary } from "@dsh-forge/plugin-semgrep";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/e2e/semgrep-unsafe", import.meta.url),
);

const SAFE = `import subprocess


def run_command(command):
    # fixed: no shell=True, no string command
    return subprocess.run(command.split())


def evaluate(expr):
    # fixed: no eval on untrusted input
    return int(expr)
`;

const tool = (name: string) =>
  semgrepPlugin.tools.find((t) => t.name === name)!;

const ctx = (workspaceRoot: string): ToolContext => ({
  workspaceRoot,
  run: runProcess,
  permission: { approved: true },
});

let workspaceRoot: string;

let hasRealSemgrep = false;
try {
  hasRealSemgrep = statSync(resolveSemgrepBinary()).isFile();
} catch {
  // not installed
}

// Story B: unsafe code -> Semgrep detects -> fix -> rescan clean.
describe.skipIf(!hasRealSemgrep)("story B: unsafe code -> Semgrep -> fix -> rescan", () => {
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-b-"));
    cpSync(FIXTURES, workspaceRoot, { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("detects eval + shell=True, fixes the source, and rescans clean", async () => {
    const scan = (path: string) =>
      tool("semgrep_security_scan").execute(
        { path, rules: "rules/no-eval.yml" },
        ctx(workspaceRoot),
      );

    const first = await scan(".");
    expect(first.ok).toBe(true);
    expect((first.diagnostics ?? []).length).toBeGreaterThan(0);

    // the fix: replace the unsafe source with a safe equivalent
    writeFileSync(join(workspaceRoot, "app.py"), SAFE, "utf8");

    const rescan = await scan(".");
    expect(rescan.ok).toBe(true);
    expect(rescan.diagnostics?.length ?? 0).toBe(0);
  }, 90_000);
});
