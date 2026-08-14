import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import type { Linter as LinterType } from "eslint";

async function loadConfig(): Promise<LinterType.FlatConfig[]> {
  const mod = (await import("../eslint.config.js")) as {
    default: LinterType.FlatConfig[];
  };
  return mod.default;
}

function shellViolations(messages: LinterType.LintMessage[]): number {
  return messages.filter((m) => m.message.includes("shell")).length;
}

describe("ADR-004 ESLint enforcement (regression: rule was a no-op)", () => {
  it("flags spawn with shell: true", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
spawn("sh", ["-c", "ls"], { shell: true });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags spawnSync with shell: true", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawnSync } from "node:child_process";
spawnSync("sh", ["-c", "ls"], { shell: true });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags exec/execSync which always run through a shell", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { exec, execSync } from "node:child_process";
exec("ls -la");
execSync("ls -la");`,
      config,
    );
    expect(shellViolations(messages)).toBe(2);
  });

  it("allows spawn without shell option", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
spawn("ls", ["-la"]);`,
      config,
    );
    expect(shellViolations(messages)).toBe(0);
  });

  it("allows spawn with shell: false", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
spawn("ls", ["-la"], { shell: false });`,
      config,
    );
    expect(shellViolations(messages)).toBe(0);
  });

  it("allows execFileSync (no shell involved)", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { execFileSync } from "node:child_process";
execFileSync("git", ["status"]);`,
      config,
    );
    expect(shellViolations(messages)).toBe(0);
  });
});
