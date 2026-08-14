import { describe, expect, it, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
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
    // A killed process reports a platform-specific exit code: null under
    // POSIX SIGKILL, 1 under Windows taskkill /F. The meaningful contract is
    // that the promise resolves with timedOut=true (no hang) and the process
    // is actually terminated (verified by the process-tree test below).
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
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
      args: [
        "-e",
        "console.log(process.env.DSH_TEST_EXPLICIT === 'present' ? 'ENV_SET' : 'ENV_MISSING')",
      ],
      env: { DSH_TEST_EXPLICIT: "present" },
    });
    expect(result.stdout.trim()).toBe("ENV_SET");
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

  // ---- regression: timeout/abort hardening flagged by review of PR #33 ----

  it("resolves even when the child ignores SIGTERM (SIGKILL escalation)", async () => {
    // The child traps SIGTERM and never exits on its own; without escalation
    // runProcess would hang forever.
    const result = await runProcess({
      binary: NODE,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)",
      ],
      timeoutMs: 300,
      signal: undefined,
    });
    expect(result.timedOut).toBe(true);
    // The promise must have resolved within a bounded window (grace + slack).
  });

  it("kills grandchild processes on timeout (process tree)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-tree-"));
    const pidFile = join(dir, "grandchild.pid");
    // Parent boots, spawns a grandchild that records its pid and sleeps, then
    // the parent sleeps. A generous timeout lets both come alive before the
    // tree-kill fires.
    const parentScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, [
        "-e",
        'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)',
        ${JSON.stringify(pidFile)},
      ], { stdio: "ignore" });
      setTimeout(() => {}, 60000);
    `;
    try {
      const result = await runProcess({
        binary: NODE,
        args: ["-e", parentScript],
        timeoutMs: 3000,
      });
      expect(result.timedOut).toBe(true);

      // grandchild recorded its pid while the tree was alive
      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isFinite(grandchildPid)).toBe(true);

      // grandchild must be gone shortly after the tree-kill
      const gone = await waitUntilNotAlive(grandchildPid, 5000);
      expect(gone).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("force-resolves even when a detached descendant holds the capture pipes", async () => {
    // A descendant detached into its own process group that inherits stdout
    // keeps the pipe open, so 'close' never fires on the parent. The runner
    // must resolve via an overall deadline instead of hanging forever.
    const dir = mkdtempSync(join(tmpdir(), "dsh-deadline-"));
    const script = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        stdio: "inherit",
        detached: true,
      });
      c.unref();
      setTimeout(() => {}, 60000);
    `;
    try {
      const startedAt = Date.now();
      const result = await runProcess({
        binary: NODE,
        args: ["-e", script],
        timeoutMs: 400,
      });
      const elapsed = Date.now() - startedAt;
      expect(result.timedOut).toBe(true);
      // resolved well before the 60s hang (timeout + grace + slack)
      expect(elapsed).toBeLessThan(15000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-redacts explicit env values from captured output", async () => {
    const result = await runProcess({
      binary: NODE,
      args: [
        "-e",
        "console.log('echo:' + (process.env.DSH_TEST_ENV_SECRET ?? 'missing'))",
      ],
      env: { DSH_TEST_ENV_SECRET: "env-super-secret-value" },
    });
    expect(result.stdout).not.toContain("env-super-secret-value");
    expect(result.stdout).toContain("[REDACTED]");
  });

  it("does not leave an open stdin pipe that can hang a child", async () => {
    const result = await runProcess({
      binary: NODE,
      args: ["-e", "let d=''; process.stdin.on('data',c=>d+=c); setTimeout(()=>{console.log('stdin-data:'+d.length)},300)"],
      timeoutMs: 2000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stdin-data:0");
  });

  it("resolves when the child exits but a descendant holds the capture pipes", async () => {
    // The parent exits immediately after spawning a detached grandchild that
    // inherits stdout, so 'close' on the child is held open by the pipe. The
    // runner must resolve via exit-destroy instead of hanging forever even
    // when no timeout is set.
    const script = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        stdio: "inherit",
        detached: true,
      });
      c.unref();
    `;
    const result = await runProcess({ binary: NODE, args: ["-e", script] });
    expect(result.exitCode).toBe(0);
  });

  it("captures large fast-exit output with exact fidelity", async () => {
    // A child that writes >64 KB (larger than the pipe buffer) and exits
    // immediately must not lose its tail: 'exit' fires before stdio drains,
    // so destroying the streams on 'exit' would drop the final chunk. The
    // output is generated inside the child (fs.writeSync) to avoid the
    // Windows command-line length limit.
    const chunk = "x".repeat(64 * 1024);
    const tail = "END-OF-OUTPUT";
    const script =
      `const fs = require("node:fs");` +
      `const buf = Buffer.from('${chunk}${tail}');` +
      `fs.writeSync(1, buf); process.exit(0);`;
    const result = await runProcess({
      binary: NODE,
      args: ["-e", script],
    });
    expect(result.truncated).toBe(false);
    expect(result.stdout.endsWith(tail)).toBe(true);
    expect(result.stdout.length).toBe(chunk.length + tail.length);
  });
});

/** True once the process with the given pid is no longer alive. */
async function waitUntilNotAlive(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
