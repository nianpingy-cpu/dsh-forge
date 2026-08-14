import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runProcess,
  buildEnv,
  redactSecrets,
  DEFAULT_ENV_ALLOWLIST,
} from "@dsh-forge/core";

const NODE = process.execPath;

describe("runProcess", () => {
  it("captures a successful execution with exit code 0 and stdout", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log('hello dsh-forge')"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello dsh-forge");
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("preserves a non-zero exit code and captures stderr", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.error('boom'); process.exit(3)"],
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("times out and kills the process", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
  });

  it("supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const promise = runProcess({
      binary: NODE,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("captures multi-line stdout verbatim", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log('a'); console.log('b')"],
    });
    expect(result.stdout).toBe("a\nb\n");
  });

  it("passes each argument as a single argv entry even with spaces and quotes", async () => {
    const tricky = 'arg with "quotes" and $shell; rm -rf /';
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", tricky],
    });
    expect(JSON.parse(result.stdout)).toEqual([tricky]);
  });

  it("runs in the requested cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-runner-cwd-"));
    try {
      const result = await runProcess({
        binary: NODE,
        args: ["-e", "console.log(process.cwd())"],
        cwd: dir,
      });
      expect(result.stdout.trim()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates output beyond maxOutputBytes and flags it", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "process.stdout.write('x'.repeat(100000))"],
      maxOutputBytes: 1024,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("does not inherit non-allowlisted environment variables", async () => {
    process.env.DSH_TEST_SECRET_LEAK = "leaky-value";
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log(process.env.DSH_TEST_SECRET_LEAK ?? 'unset')"],
    });
    expect(result.stdout.trim()).toBe("unset");
  });

  it("passes explicitly provided env entries to the child", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log(process.env.DSH_TEST_EXPLICIT ?? 'unset')"],
      env: { DSH_TEST_EXPLICIT: "present" },
    });
    expect(result.stdout.trim()).toBe("present");
  });

  it("redacts secret values from captured output", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log('token=abc123supersecret done')"],
      redact: ["abc123supersecret"],
    });
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("abc123supersecret");
  });

  it("accepts an absolute Windows-style binary path", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "console.log('ok')"],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("normalizes a missing binary into BinaryNotFound", async () => {
    const result = await runProcess({
      binary: "dsh-forge-definitely-missing-binary-xyz",
      args: ["--version"],
    });
    expect(result.error?.code).toBe("BinaryNotFound");
    expect(result.error?.message).toMatch(
      /dsh-forge-definitely-missing-binary-xyz/,
    );
  });
});

describe("buildEnv", () => {
  it("keeps only allowlisted inherited variables plus explicit entries", () => {
    process.env.DSH_TEST_BUILDENV_SECRET = "nope";
    const env = buildEnv(
      [...DEFAULT_ENV_ALLOWLIST],
      { DSH_TEST_EXPLICIT: "yes" },
    );
    expect(env.DSH_TEST_BUILDENV_SECRET).toBeUndefined();
    expect(env.DSH_TEST_EXPLICIT).toBe("yes");
    expect(typeof env.PATH).toBe("string");
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret", () => {
    expect(redactSecrets("a b a", ["a"])).toBe("[REDACTED] b [REDACTED]");
  });

  it("ignores empty secret strings", () => {
    expect(redactSecrets("unchanged", [""])).toBe("unchanged");
  });
});

afterAll(() => {
  delete process.env.DSH_TEST_SECRET_LEAK;
  delete process.env.DSH_TEST_BUILDENV_SECRET;
});
