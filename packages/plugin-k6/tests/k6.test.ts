import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { k6Plugin, resolveK6Binary } from "@dsh-forge/plugin-k6";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/k6", import.meta.url));

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-k6-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

/**
 * Real-runner used by the opt-in live tests: delegates directly to runProcess
 * (k6 is installed on CI). No BinaryNotFound fallback — the live tests are
 * gated on hasRealK6 and skip cleanly when k6 is absent.
 */
function k6Runner(req: ExecutionRequest): Promise<ExecutionResult> {
  return runProcess(req);
}

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

let hasRealK6 = false;
try {
  hasRealK6 = statSync(resolveK6Binary()).isFile();
} catch {
  // not installed
}

const OK = {
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
};

const RUN_OUTPUT = [
  "     ✓ status is 200",
  "",
  "     checks.........................: 100.00% ✓ 990      ✗ 0",
  "     data_received..................: 12 MB  101 kB/s",
  "     http_req_duration..............: avg=42.5ms min=10.2ms med=41ms max=120.3ms p(90)=60.1ms p(95)=75.4ms",
  "     http_req_failed................: 0.00%   ✓ 990      ✗ 0",
  "     iterations.....................: 1234   10.28/s",
  "     vus............................: 50     min=50     max=50",
  "",
  "running (2m00.0s), 0/50 VUs, 1234 complete and 0 interrupted iterations",
].join("\n");

const RUN_OUTPUT_HTTP_ERRORS = [
  "     ✗ status is 200",
  "",
  "     checks.........................: 60.00% ✓ 600      ✗ 400",
  "     http_req_duration..............: avg=412.5ms min=40.2ms med=380ms max=1220.3ms p(90)=620.1ms p(95)=820.4ms",
  "     http_req_failed................: 20.00%  ✓ 800      ✗ 200",
  "     iterations.....................: 1000   8.33/s",
].join("\n");

function mockRunner(
  overrides: Record<string, ExecutionRunner> = {},
): ExecutionRunner {
  return async (req) => {
    const sub = req.args[0] ?? "";
    if (overrides[sub]) return overrides[sub](req);
    switch (sub) {
      case "version":
        return {
          exitCode: 0,
          stdout: "k6 v0.53.0 (go1.22.4, linux/amd64)",
          stderr: "",
          ...OK,
        };
      case "run":
        return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
      default:
        return { exitCode: 1, stdout: "", stderr: "unknown command", ...OK };
    }
  };
}

describe("resolveK6Binary", () => {
  it("resolves the k6 binary to an absolute path", () => {
    expect(resolveK6Binary()).toBeTruthy();
    expect(isAbsolute(resolveK6Binary())).toBe(true);
  });

  it("uses an unpredictable absolute sentinel when k6 is absent", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "dsh-empty-" + randomUUID());
      const a = resolveK6Binary();
      const b = resolveK6Binary();
      expect(isAbsolute(a)).toBe(true);
      expect(a).not.toBe("k6");
      expect(a).not.toBe(b);
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("k6_version", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_version")!;

  it("reports the k6 version", async () => {
    const result = await tool().execute({}, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/k6 v/i);
    expect(result.raw).toContain("0.53.0");
  });

  it("reports BinaryNotFound when the k6 binary is missing", async () => {
    const missing: ExecutionRunner = async () => ({
      error: { code: "BinaryNotFound", message: "ENOENT" },
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({}, ctx(missing));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });
});

describe("k6_run (process)", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_run")!;

  it("passes when thresholds are met", async () => {
    const result = await tool().execute(
      { script: "script.js" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/passed/i);
    expect(result.raw).toContain("http_req_duration");
  });

  it("reports threshold failures as a completed run", async () => {
    const runner = mockRunner({
      run: async () => ({ exitCode: 1, stdout: RUN_OUTPUT, stderr: "", ...OK }),
    });
    const result = await tool().execute(
      { script: "script.js" },
      ctx(runner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/thresholds failed/i);
    expect(result.raw).toContain("http_req_duration");
  });

  it("surfaces HTTP errors in the raw output", async () => {
    const runner = mockRunner({
      run: async () => ({
        exitCode: 0,
        stdout: RUN_OUTPUT_HTTP_ERRORS,
        stderr: "",
        ...OK,
      }),
    });
    const result = await tool().execute(
      { script: "script.js" },
      ctx(runner),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toContain("http_req_failed");
    expect(result.raw).toContain("20.00%");
  });

  it("reports an invalid script as a tool failure", async () => {
    const runner = mockRunner({
      run: async () => ({
        exitCode: 99,
        stdout: "",
        stderr: "level=error msg=\"failed to parse script\"",
        ...OK,
      }),
    });
    const result = await tool().execute(
      { script: "script.js" },
      ctx(runner),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/parse script/i);
  });

  it("denies without permission approval (process)", async () => {
    const result = await tool().execute(
      { script: "script.js" },
      ctx(mockRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("rejects an empty or leading-dash script", async () => {
    const a = await tool().execute({ script: "" }, ctx(mockRunner()));
    const b = await tool().execute({ script: "--out" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("rejects a script outside the workspace", async () => {
    const result = await tool().execute(
      { script: "../outside/script.js" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("caps an explicit long duration timeout at 30 minutes", async () => {
    let captured: ExecutionRequest | undefined;
    const capture: ExecutionRunner = async (req) => {
      captured = req;
      return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
    };
    const result = await tool().execute(
      { script: "script.js", duration: "1h" },
      ctx(capture),
    );
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.timeoutMs).toBe(30 * 60_000);
  });
});

describe("k6_smoke (process)", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_smoke")!;

  it("runs a 1-VU smoke test with a short duration", async () => {
    let captured: ExecutionRequest | undefined;
    const capture: ExecutionRunner = async (req) => {
      captured = req;
      return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
    };
    const result = await tool().execute({ script: "script.js" }, ctx(capture));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.args).toContain("--vus");
    expect(captured!.args).toContain("1");
  });

  it("denies without permission approval (process)", async () => {
    const result = await tool().execute(
      { script: "script.js" },
      ctx(mockRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });
});

describe("k6_load (process)", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_load")!;

  it("runs a load test with default load", async () => {
    let captured: ExecutionRequest | undefined;
    const capture: ExecutionRunner = async (req) => {
      captured = req;
      return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
    };
    const result = await tool().execute({ script: "script.js" }, ctx(capture));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.args).toContain("--vus");
    expect(captured!.args).toContain("50");
    expect(captured!.args).toContain("--duration");
  });

  it("denies without permission approval (process)", async () => {
    const result = await tool().execute(
      { script: "script.js" },
      ctx(mockRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });
});

describe("k6_stress (process)", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_stress")!;

  it("runs a stress test with high load", async () => {
    let captured: ExecutionRequest | undefined;
    const capture: ExecutionRunner = async (req) => {
      captured = req;
      return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
    };
    const result = await tool().execute({ script: "script.js" }, ctx(capture));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.args).toContain("--vus");
    expect(captured!.args).toContain("200");
  });

  it("scales the timeout with the test duration (5m stress is not killed at 300s)", async () => {
    let captured: ExecutionRequest | undefined;
    const capture: ExecutionRunner = async (req) => {
      captured = req;
      return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
    };
    const result = await tool().execute({ script: "script.js" }, ctx(capture));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.timeoutMs!).toBeGreaterThan(300_000);
  });

  it("denies without permission approval (process)", async () => {
    const result = await tool().execute(
      { script: "script.js" },
      ctx(mockRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });
});

describe("k6_summary (read)", () => {
  const tool = () => k6Plugin.tools.find((t) => t.name === "k6_summary")!;

  it("summarizes a k6 summary-export JSON", async () => {
    const result = await tool().execute({ path: "summary.json" }, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("http_req_duration");
    expect(result.summary).toContain("p(95)");
    expect(result.raw).toContain("1234");
  });

  it("rejects malformed JSON as a ParseFailure", async () => {
    writeFileSync(join(workspaceRoot, "bad.json"), "{ not json", "utf8");
    const result = await tool().execute({ path: "bad.json" }, ctx(mockRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("rejects a path outside the workspace", async () => {
    const result = await tool().execute(
      { path: "../outside/summary.json" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an empty or leading-dash path", async () => {
    const a = await tool().execute({ path: "" }, ctx(mockRunner()));
    const b = await tool().execute({ path: "--summary-export" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });
});

describe("k6_threshold_check (read)", () => {
  const tool = () =>
    k6Plugin.tools.find((t) => t.name === "k6_threshold_check")!;

  it("reports all thresholds passed", async () => {
    const result = await tool().execute(
      { path: "summary.json" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/passed/i);
    expect(result.summary).toContain("1");
  });

  it("reports failed thresholds", async () => {
    const result = await tool().execute(
      { path: "summary-fail.json" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/failed/i);
    expect(result.summary).toContain("p(95)<500");
  });

  it("reports when no thresholds are defined", async () => {
    writeFileSync(
      join(workspaceRoot, "nothreshold.json"),
      JSON.stringify({ metrics: { iterations: { type: "counter", values: { count: 1 } } } }),
      "utf8",
    );
    const result = await tool().execute(
      { path: "nothreshold.json" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no thresholds/i);
  });

  it("rejects malformed JSON as a ParseFailure", async () => {
    writeFileSync(join(workspaceRoot, "bad2.json"), "[1,2", "utf8");
    const result = await tool().execute(
      { path: "bad2.json" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });
});

describe("robustness", () => {
  it("treats a null exit code (killed/crashed k6) as a ToolFailure, not success", async () => {
    const killed: ExecutionRunner = async () => ({
      exitCode: null,
      stdout: RUN_OUTPUT,
      stderr: "",
      ...OK,
    });
    const tool = () => k6Plugin.tools.find((t) => t.name === "k6_run")!;
    const result = await tool().execute({ script: "script.js" }, ctx(killed));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/killed|crashed/i);
  });

  it("surfaces a timeout as a ToolFailure", async () => {
    const slow: ExecutionRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      aborted: false,
      truncated: false,
      durationMs: 300_000,
    });
    const tool = () => k6Plugin.tools.find((t) => t.name === "k6_run")!;
    const result = await tool().execute({ script: "script.js" }, ctx(slow));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("Timeout");
  });
});

describe("live k6 (opt-in)", () => {
  it("runs a minimal k6 script when k6 is installed", async () => {
    if (!hasRealK6) return;
    const tool = () => k6Plugin.tools.find((t) => t.name === "k6_run")!;
    const result = await tool().execute(
      { script: "script-minimal.js", vus: 1, duration: "1s" },
      ctx(k6Runner),
    );
    expect(result.ok).toBe(true);
  }, 60_000);

  it("parses a real k6 summary-export when k6 is installed", async () => {
    if (!hasRealK6) return;
    const outFile = join(workspaceRoot, "live-summary.json");
    const res = await k6Runner({
      binary: resolveK6Binary(),
      args: [
        "run",
        "--summary-export",
        outFile,
        "--vus",
        "1",
        "--duration",
        "1s",
        join(workspaceRoot, "script-minimal.js"),
      ],
      cwd: workspaceRoot,
      timeoutMs: 60_000,
    });
    if (res.error || res.exitCode !== 0 || !existsSync(outFile)) {
      // summary-export flag unavailable/removed in this k6 version; skip.
      return;
    }
    const tool = () => k6Plugin.tools.find((t) => t.name === "k6_summary")!;
    const result = await tool().execute(
      { path: "live-summary.json" },
      ctx(k6Runner),
    );
    expect(result.ok).toBe(true);
  }, 60_000);
});

describe("default export", () => {
  it("exports a default Plugin object (Plugin Standard)", async () => {
    const mod = await import("@dsh-forge/plugin-k6");
    const def = (
      mod as { default?: { metadata?: unknown; tools?: unknown } }
    ).default;
    expect(def).toBeTruthy();
    expect((def as { metadata: { name: string } }).metadata.name).toBe(
      "@dsh-forge/plugin-k6",
    );
    expect(Array.isArray((def as { tools: unknown[] }).tools)).toBe(true);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const routing: ExecutionRunner = async (req) => {
      switch (req.args[0]) {
        case "version":
          return { exitCode: 0, stdout: "k6 v0.53.0", stderr: "", ...OK };
        case "run":
          return { exitCode: 0, stdout: RUN_OUTPUT, stderr: "", ...OK };
        default:
          return { exitCode: 1, stdout: "", stderr: "unknown", ...OK };
      }
    };
    const report = await runContractSuite(k6Plugin, {
      workspaceRoot,
      runner: routing,
      // Read-only version tool reaches ctx.run without a permission gate.
      missingBinaryTool: "k6_version",
      missingBinaryToolArgs: {},
      toolArgs: {
        k6_version: { valid: {}, invalid: { unexpected: 1 } },
        k6_run: {
          valid: { script: "script.js" },
          invalid: { script: 42 },
        },
        k6_smoke: {
          valid: { script: "script.js" },
          invalid: { script: 42 },
        },
        k6_load: {
          valid: { script: "script.js", vus: 100, duration: "1m" },
          invalid: { script: 42 },
        },
        k6_stress: {
          valid: { script: "script.js", vus: 300, duration: "2m" },
          invalid: { script: 42 },
        },
        k6_summary: {
          valid: { path: "summary.json" },
          invalid: { path: 42 },
        },
        k6_threshold_check: {
          valid: { path: "summary.json" },
          invalid: { path: 42 },
        },
      },
    });
    if (!report.passed) {
      for (const check of report.checks) {
        if (!check.passed)
          console.error("failed check:", check.name, check.detail);
      }
    }
    expect(report.passed).toBe(true);
  });
});
