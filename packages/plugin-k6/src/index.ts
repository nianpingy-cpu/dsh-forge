/**
 * k6 adapter (ISSUE-022) — load-testing tools.
 *
 * Typed tools compiled to k6 argv[] — no shell, no free-form commands.
 *   k6_version           (read)     k6 version
 *   k6_run               (process)  k6 run <script> [--vus N] [--duration D]
 *   k6_smoke             (process)  k6 run <script> --vus 1 --duration <short>
 *   k6_load              (process)  k6 run <script> --vus <N> --duration <D>
 *   k6_stress            (process)  k6 run <script> --vus <N> --duration <D>
 *   k6_summary           (read)     parse a k6 --summary-export JSON file
 *   k6_threshold_check   (read)     evaluate thresholds in a k6 summary JSON
 *
 * Script generation stays with the agent; the plugin only executes/parses.
 *
 * k6 exit-code semantics: 0 = all thresholds passed, 1 = thresholds failed
 * (still a completed run with a reportable result), 99+ = script/runtime
 * error (surfaced as ToolFailure). k6_summary / k6_threshold_check are pure
 * parsers of a `--summary-export` JSON file (no binary needed).
 */
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  parseJsonOutput,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ExecutionResult,
} from "@dsh-forge/core";
import { readFileSync } from "node:fs";
import { resolveK6Binary, K6_BINARY_HINT } from "./binary.js";

const TOOL = "k6";

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function binaryNotFound(binary: string): ToolResult {
  return {
    ok: false,
    summary: `k6 binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: K6_BINARY_HINT },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message: "k6 execution requires explicit approval (process)",
    },
  };
}

/** Redact embedded credentials from text before it reaches the model. */
function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/([A-Za-z0-9_.-]+):([^@\s/]+)@/g, "$1:***@");
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "k6 failed",
    error: { code: "ToolFailure", message: redactCredentials(message) },
  };
}

/** First non-empty stderr line (credential-redacted) or a stable fallback. */
function firstErrorLine(exitCode: number, stderr: string): string {
  const line = stderr.trim().split("\n").find((l) => l.trim() !== "");
  return redactCredentials(line ?? `k6 exited with code ${exitCode}`);
}

/** Reject empty or leading-dash paths (flag injection). */
function isValidPathInput(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && !/^\s*-/.test(value)
  );
}

/** k6 --duration values: a positive integer plus a single unit. */
function isValidDuration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+(ms|s|m|h)$/.test(value.trim())
  );
}

/**
 * Run a k6 CLI command through the core runner. Only BinaryNotFound, Timeout,
 * truncated output, runner errors and signal-death (null exit code) fail
 * here; the exit code is passed through so callers can interpret k6's
 * pass/fail/error semantics.
 */
async function runK6(
  ctx: ToolContext,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; exec: ExecutionResult & { exitCode: number } } | { ok: false; result: ToolResult }> {
  const binary = resolveK6Binary();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  let exec: ExecutionResult;
  try {
    exec = await ctx.run({
      binary,
      args: [...args],
      cwd: ctx.workspaceRoot,
      timeoutMs,
      maxOutputBytes: 20 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, result: toolFailure(`k6 runner threw: ${String(err)}`) };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (exec.timedOut || exec.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 timed out",
        error: { code: "Timeout", message: `k6 exceeded the ${timeoutMs}ms timeout` },
      },
    };
  }
  if (exec.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 output exceeded the cap",
        error: {
          code: "ToolFailure",
          message:
            "k6 output exceeded the 20 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (exec.error) {
    return { ok: false, result: toolFailure(exec.error.message) };
  }
  if (exec.exitCode === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 terminated abnormally",
        error: {
          code: "ToolFailure",
          message:
            "k6 was killed or crashed (no exit code); the result is unreliable",
        },
      },
    };
  }
  return { ok: true, exec: { ...exec, exitCode: exec.exitCode } };
}

function okResult(summary: string, raw: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...[truncated]" : raw,
  };
}

/** Hard ceiling on a single k6 run (test window + startup/summary margin). */
const MAX_RUN_TIMEOUT = 30 * 60_000;
const DURATION_CEILING_MSG =
  "duration exceeds the 30-minute ceiling (the run timeout is duration + a 90s margin)";

/** Parse a k6 duration like "30s"/"5m"/"1h" into milliseconds (NaN if invalid). */
function durationMs(d: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return NaN;
  }
}

/**
 * Scale the process timeout with the requested test duration so a long test
 * window (e.g. k6_stress's 5m default) is never killed by a fixed short
 * timeout. Adds a 90s margin for k6 startup + summary shutdown, capped at
 * 30 minutes. Falls back to `fallbackMs` when no parseable duration is given
 * (a script-defined duration is unknown).
 */
function runTimeout(duration: string | undefined, fallbackMs: number): number {
  if (duration !== undefined) {
    const ms = durationMs(duration);
    if (Number.isFinite(ms)) {
      return Math.min(ms + 90_000, MAX_RUN_TIMEOUT);
    }
  }
  return fallbackMs;
}

/** True when the duration's needed timeout fits within the 30-minute ceiling. */
function durationWithinCeiling(duration: string): boolean {
  const ms = durationMs(duration);
  return Number.isFinite(ms) && ms + 90_000 <= MAX_RUN_TIMEOUT;
}

/** Resolve a workspace-relative script path; never throws. */
function resolveScript(
  ctx: ToolContext,
  script: string,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(script)) {
    return { ok: false, result: invalid("script must be a non-empty workspace path") };
  }
  try {
    return { ok: true, absolute: resolveInWorkspace(ctx.workspaceRoot, script) };
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${script}` },
        },
      };
    }
    return {
      ok: false,
      result: toolFailure(`script path could not be resolved: ${String(err)}`),
    };
  }
}

/**
 * Interpret a completed k6 run: exit 0 = passed, exit 1 = thresholds failed
 * (both are completed runs with a reportable result); any other exit code is
 * a script/runtime error surfaced as ToolFailure.
 */
function k6RunResult(run: { exec: { exitCode: number; stdout: string; stderr: string } }): ToolResult {
  // k6 echoes per-request errors to stderr that include the full target URL
  // (possibly with embedded basic-auth credentials, e.g. http://user:pass@host/)
  // even on exit 0 when thresholds still pass. Redact on the success path too.
  const raw = redactCredentials(run.exec.stdout + run.exec.stderr);
  if (run.exec.exitCode === 0) {
    return okResult("k6 run completed (all thresholds passed)", raw);
  }
  if (run.exec.exitCode === 1) {
    return okResult("k6 run completed; thresholds failed (exit 1)", raw);
  }
  return toolFailure(
    firstErrorLine(run.exec.exitCode, run.exec.stderr) ??
      `k6 exited with code ${run.exec.exitCode}`,
  );
}

interface K6Metric {
  type?: unknown;
  contains?: unknown;
  values?: Record<string, number>;
  thresholds?: { name?: unknown; ok?: unknown }[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fmt(v: unknown, unit = ""): string {
  return typeof v === "number" ? `${v}${unit}` : "?";
}

function formatMetric(name: string, m: K6Metric): string {
  const values = m.values ?? {};
  const type = typeof m.type === "string" ? m.type : "";
  switch (type) {
    case "trend":
      return `${name}: avg=${fmt(values.avg, "ms")} p(90)=${fmt(values["p(90)"], "ms")} p(95)=${fmt(values["p(95)"], "ms")} max=${fmt(values.max, "ms")}`;
    case "rate": {
      const rate = num(values.rate);
      return `${name}: ${rate === undefined ? "?" : `${(rate * 100).toFixed(2)}%`}`;
    }
    case "counter":
      return `${name}: count=${fmt(values.count)} rate=${fmt(values.rate)}/s`;
    case "gauge":
      return `${name}: ${fmt(values.value ?? values.max)}`;
    default:
      return `${name}: ${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`;
  }
}

/** Read + parse a workspace summary-export JSON file; never throws. */
function readSummary(
  ctx: ToolContext,
  path: string,
): { ok: true; data: { metrics?: Record<string, K6Metric> } } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(path)) {
    return { ok: false, result: invalid("path must be a non-empty workspace path") };
  }
  let absolute: string;
  try {
    absolute = resolveInWorkspace(ctx.workspaceRoot, path);
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${path}` },
        },
      };
    }
    return { ok: false, result: toolFailure(`path could not be resolved: ${String(err)}`) };
  }
  let content: string;
  try {
    content = readFileSync(absolute, "utf8");
  } catch (err) {
    return { ok: false, result: toolFailure(`could not read summary: ${String(err)}`) };
  }
  const parsed = parseJsonOutput(TOOL, content);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 parse failed",
        error: { code: "ParseFailure", message: parsed.error },
      },
    };
  }
  const data = parsed.value as Record<string, unknown>;
  if (typeof data !== "object" || data === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 parse failed",
        error: { code: "ParseFailure", message: "k6: expected a summary JSON object" },
      },
    };
  }
  if (data.metrics !== undefined && typeof data.metrics !== "object") {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "k6 parse failed",
        error: { code: "ParseFailure", message: "k6: expected metrics to be an object" },
      },
    };
  }
  return { ok: true, data: data as { metrics?: Record<string, K6Metric> } };
}

const k6Version: ToolDefinition = {
  name: "k6_version",
  description: "Report the installed k6 version (read-only).",
  mutationClass: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const run = await runK6(ctx, ["version"], { timeoutMs: 30_000 });
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const version = run.exec.stdout.trim() || "(no version reported)";
    return okResult(`k6 ${version}`, version);
  },
};

const k6Run: ToolDefinition = {
  name: "k6_run",
  description:
    "Run a k6 load-test script (process: executes k6, which may hit network targets from the script; requires approval). Exit 0 = thresholds passed, exit 1 = thresholds failed (both returned as completed runs).",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "workspace-relative path to a k6 script (.js)",
      },
      vus: { type: "number", description: "virtual users (default: script options or 1)" },
      duration: {
        type: "string",
        description:
          "test duration, e.g. 30s, 1m, 1h (capped at ~28.5m; the run timeout is duration + a 90s margin, max 30m)",
      },
    },
    required: ["script"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { script, vus, duration } = validated.value as {
      script: string;
      vus?: number;
      duration?: string;
    };
    const resolved = resolveScript(ctx, script);
    if (!resolved.ok) return resolved.result;
    if (vus !== undefined && (!Number.isInteger(vus) || vus <= 0)) {
      return invalid("vus must be a positive integer");
    }
    if (duration !== undefined && !isValidDuration(duration)) {
      return invalid("duration must be a positive value with a unit, e.g. 30s, 1m, 1h");
    }
    if (duration !== undefined && !durationWithinCeiling(duration)) {
      return invalid(DURATION_CEILING_MSG);
    }
    const argv = [
      "run",
      resolved.absolute,
      ...(vus !== undefined ? ["--vus", String(vus)] : []),
      ...(duration !== undefined ? ["--duration", duration.trim()] : []),
    ];
    const run = await runK6(ctx, argv, {
      // Scale with an explicit duration; a script-defined duration is
      // unknown, so fall back to the 30-minute ceiling.
      timeoutMs: runTimeout(duration?.trim(), MAX_RUN_TIMEOUT),
    });
    if (!run.ok) return run.result;
    return k6RunResult(run);
  },
};

const k6Smoke: ToolDefinition = {
  name: "k6_smoke",
  description:
    "Run a quick k6 smoke test: 1 virtual user for a short duration (process; requires approval).",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "workspace-relative k6 script" },
      duration: {
        type: "string",
        description: "smoke duration (default 30s)",
      },
    },
    required: ["script"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { script, duration } = validated.value as {
      script: string;
      duration?: string;
    };
    const resolved = resolveScript(ctx, script);
    if (!resolved.ok) return resolved.result;
    const d = duration ?? "30s";
    if (!isValidDuration(d)) {
      return invalid("duration must be a positive value with a unit, e.g. 30s, 1m");
    }
    if (!durationWithinCeiling(d)) {
      return invalid(DURATION_CEILING_MSG);
    }
    const run = await runK6(
      ctx,
      ["run", resolved.absolute, "--vus", "1", "--duration", d.trim()],
      { timeoutMs: runTimeout(d, 300_000) },
    );
    if (!run.ok) return run.result;
    return k6RunResult(run);
  },
};

const k6Load: ToolDefinition = {
  name: "k6_load",
  description:
    "Run a k6 load test: sustained virtual users over a duration (process; requires approval).",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "workspace-relative k6 script" },
      vus: { type: "number", description: "virtual users (default 50)" },
      duration: { type: "string", description: "duration (default 2m)" },
    },
    required: ["script"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { script, vus, duration } = validated.value as {
      script: string;
      vus?: number;
      duration?: string;
    };
    const resolved = resolveScript(ctx, script);
    if (!resolved.ok) return resolved.result;
    const v = vus ?? 50;
    if (!Number.isInteger(v) || v <= 0) return invalid("vus must be a positive integer");
    const d = duration ?? "2m";
    if (!isValidDuration(d)) return invalid("duration must be a positive value with a unit");
    if (!durationWithinCeiling(d)) return invalid(DURATION_CEILING_MSG);
    const run = await runK6(
      ctx,
      ["run", resolved.absolute, "--vus", String(v), "--duration", d.trim()],
      { timeoutMs: runTimeout(d, 300_000) },
    );
    if (!run.ok) return run.result;
    return k6RunResult(run);
  },
};

const k6Stress: ToolDefinition = {
  name: "k6_stress",
  description:
    "Run a k6 stress test: high virtual-user load over a duration (process; requires approval).",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "workspace-relative k6 script" },
      vus: { type: "number", description: "virtual users (default 200)" },
      duration: { type: "string", description: "duration (default 5m)" },
    },
    required: ["script"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { script, vus, duration } = validated.value as {
      script: string;
      vus?: number;
      duration?: string;
    };
    const resolved = resolveScript(ctx, script);
    if (!resolved.ok) return resolved.result;
    const v = vus ?? 200;
    if (!Number.isInteger(v) || v <= 0) return invalid("vus must be a positive integer");
    const d = duration ?? "5m";
    if (!isValidDuration(d)) return invalid("duration must be a positive value with a unit");
    if (!durationWithinCeiling(d)) return invalid(DURATION_CEILING_MSG);
    const run = await runK6(
      ctx,
      ["run", resolved.absolute, "--vus", String(v), "--duration", d.trim()],
      { timeoutMs: runTimeout(d, 300_000) },
    );
    if (!run.ok) return run.result;
    return k6RunResult(run);
  },
};

const k6Summary: ToolDefinition = {
  name: "k6_summary",
  description:
    "Parse a k6 --summary-export JSON file into a structured metric summary (read-only; no binary needed).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "workspace-relative path to a k6 summary-export JSON file",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path } = validated.value as { path: string };
    const read = readSummary(ctx, path);
    if (!read.ok) return read.result;
    const metrics = read.data.metrics ?? {};
    const names = Object.keys(metrics);
    const lines = names.slice(0, 10).map((name) => formatMetric(name, metrics[name] ?? {}));
    if (lines.length === 0) {
      return okResult("k6 summary: no metrics", JSON.stringify(read.data, null, 2));
    }
    return okResult(
      `k6 summary (${names.length} metric(s)): ${lines.join(" | ")}`,
      JSON.stringify(read.data, null, 2),
    );
  },
};

const k6ThresholdCheck: ToolDefinition = {
  name: "k6_threshold_check",
  description:
    "Evaluate the thresholds declared in a k6 --summary-export JSON file (read-only; no binary needed).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "workspace-relative path to a k6 summary-export JSON file",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path } = validated.value as { path: string };
    const read = readSummary(ctx, path);
    if (!read.ok) return read.result;
    const metrics = read.data.metrics ?? {};
    type T = { metric: string; name: string; ok: boolean };
    const all: T[] = [];
    for (const [metric, m] of Object.entries(metrics)) {
      for (const t of m.thresholds ?? []) {
        if (typeof t?.name === "string") {
          all.push({ metric, name: t.name, ok: t.ok === true });
        }
      }
    }
    if (all.length === 0) {
      return okResult("k6 threshold check: no thresholds defined", JSON.stringify(all, null, 2));
    }
    const failed = all.filter((t) => !t.ok);
    if (failed.length === 0) {
      return okResult(
        `k6 threshold check: all ${all.length} threshold(s) passed`,
        JSON.stringify(all, null, 2),
      );
    }
    const names = failed.map((t) => `${t.metric} ${t.name}`).join(", ");
    return okResult(
      `k6 threshold check: ${failed.length} of ${all.length} threshold(s) failed: ${names}`,
      JSON.stringify(all, null, 2),
    );
  },
};

export const k6Plugin: {
  metadata: {
    name: string;
    version: string;
    upstreamTool: string;
    coreContractVersion: string;
    capabilities: readonly string[];
  };
  tools: readonly ToolDefinition[];
} = {
  metadata: {
    name: "@dsh-forge/plugin-k6",
    version: "0.1.0",
    upstreamTool: "k6",
    coreContractVersion: "0.1.0",
    capabilities: [
      "version",
      "run",
      "smoke",
      "load",
      "stress",
      "summary",
      "threshold-check",
      "process",
    ],
  },
  tools: [
    k6Version,
    k6Run,
    k6Smoke,
    k6Load,
    k6Stress,
    k6Summary,
    k6ThresholdCheck,
  ],
};

export { resolveK6Binary, K6_BINARY_HINT };

export default k6Plugin;
