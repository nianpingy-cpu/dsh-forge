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
  }, 30_000);

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

  // ---- regression: bypass forms flagged by external review of PR #31 ----

  it("flags exec through a namespace import (member expression)", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import * as cp from "node:child_process";
cp.exec("rm -rf /");`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags spawn through a namespace import with shell: true", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import * as cp from "node:child_process";
cp.spawn("sh", ["-c", cmd], { shell: true });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags an aliased spawn import", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn as sp } from "node:child_process";
sp("sh", ["-c", cmd], { shell: true });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("does NOT flag a local function merely named exec", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `function exec(a) { return a; }
exec("hello");`,
      config,
    );
    expect(shellViolations(messages)).toBe(0);
  });

  it("flags require-destructured spawnSync from child_process", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `const { spawnSync } = require("node:child_process");
spawnSync("sh", ["-c", "ls"], { shell: true });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  // ---- regression round 2: binding forms flagged by re-review of PR #31 ----

  it("flags exec via a plain require namespace binding", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `const cp = require("node:child_process");
cp.exec("rm -rf /");`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags computed member access on a namespace binding", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import * as cp from "node:child_process";
cp["exec"]("rm -rf /");`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags spawn with a variable-held options object that has shell: true", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
const opts = { shell: true };
spawn("sh", ["-c", cmd], opts);`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("allows spawn with a variable-held options object that has shell: false", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
const opts = { shell: false };
spawn("ls", ["-la"], opts);`,
      config,
    );
    expect(shellViolations(messages)).toBe(0);
  });

  it("flags destructured exec via createRequire", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { exec } = req("node:child_process");
exec("rm -rf /");`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  // ---- regression round 3: forms flagged by third re-review of PR #31 ----

  it("flags inline createRequire chain member access", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { createRequire } from "node:module";
createRequire(import.meta.url)("node:child_process").execSync("rm -rf /");`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags an options object mutated to shell: true after declaration", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
const o = { shell: false };
o.shell = true;
spawn("sh", ["-c", cmd], o);`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });

  it("flags spawn with options spread from an object that has shell: true", async () => {
    const config = await loadConfig();
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      `import { spawn } from "node:child_process";
const base = { shell: true };
spawn("sh", ["-c", cmd], { ...base });`,
      config,
    );
    expect(shellViolations(messages)).toBeGreaterThan(0);
  });
});
