/**
 * act adapter (ISSUE-015) — local GitHub Actions runner.
 *
 * Typed tools compiled to act argv[] — no shell, no free-form commands.
 *   read:            act_list_workflows, act_list_jobs, act_failure_summary
 *   process:         act_dry_run
 *   system-change:   act_run, act_run_job   (execute containers / change state
 *                     outside the workspace — permission-gated)
 *
 * Docker is required to actually run jobs. Docker availability is probed
 * BEFORE invoking act for the run tools, and a missing/unreachable Docker is
 * reported as an explicit "Docker is not available" tool error — never as a
 * workflow failure. `act -l` (list) works without Docker.
 *
 * act reads `.actrc` from its process cwd and home dir, which is a flag-
 * injection vector when cwd is the workspace. Every act invocation therefore
 * runs from a neutral runtime dir (no .actrc), points at the project with
 * `-C`, and neutralizes HOME/USERPROFILE so a repo-planted `.actrc` cannot
 * inject arbitrary act flags (--privileged, --secret, --network, ...).
 */
import {
  validateArgs,
  assertPermission,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ExecutionResult,
} from "@dsh-forge/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveActBinary,
  resolveDockerBinary,
  ACT_BINARY_HINT,
} from "./binary.js";

// Platform → image overrides so act does not prompt interactively for a
// default image on first run (it otherwise blocks waiting for input).
const PLATFORM_FLAGS = [
  "-P",
  "ubuntu-latest=catthehacker/ubuntu:act-latest",
  "-P",
  "ubuntu-24.04=catthehacker/ubuntu:act-24.04",
  "-P",
  "ubuntu-22.04=catthehacker/ubuntu:act-22.04",
  "-P",
  "ubuntu-20.04=catthehacker/ubuntu:act-20.04",
] as const;

/**
 * Create a fresh, random runtime dir used as act's process cwd + HOME so a
 * repo-controlled `.actrc` in the workspace is never read (act loads .actrc
 * from its cwd + home). A random dir per invocation (mkdtemp) also prevents a
 * local attacker from pre-creating a predictable path in a world-writable
 * /tmp and planting a malicious .actrc there (predictable-path TOCTOU).
 */
function runtimeDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-act-runtime-"));
}

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
    summary: `act binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: ACT_BINARY_HINT },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "act failed",
    error: { code: "ToolFailure", message },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message:
        "this tool is a workspace-write/process mutation and requires permission approval",
    },
  };
}

/** Docker unavailable is an environment problem, NOT a workflow failure. */
function dockerUnavailable(reason: string): ToolResult {
  return {
    ok: false,
    summary: "docker unavailable",
    error: {
      code: "ToolFailure",
      message: `Docker is not available (${reason}); cannot run act jobs. This is an environment issue, not a workflow failure.`,
    },
  };
}

function okResult(summary: string, raw: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...[truncated]" : raw,
  };
}

/**
 * Probe Docker availability via `docker info`. Returns available:false with a
 * reason when the binary is missing, the daemon is unreachable, or the probe
 * times out. Never throws.
 */
async function detectDocker(
  ctx: ToolContext,
): Promise<{ available: boolean; reason?: string }> {
  let exec: ExecutionResult;
  try {
    exec = await ctx.run({
      // Absolute path (never a bare name): a repo-planted docker.exe in the
      // workspace must never be executed via Windows CreateProcess cwd-search.
      binary: resolveDockerBinary(),
      args: ["info", "--format", "{{.ServerVersion}}"],
      cwd: ctx.workspaceRoot,
      timeoutMs: 15_000,
      maxOutputBytes: 1 << 20,
    });
  } catch (err) {
    return { available: false, reason: `docker probe threw: ${String(err)}` };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return { available: false, reason: "docker binary not found" };
  }
  if (exec.error) {
    return { available: false, reason: exec.error.message };
  }
  if (exec.timedOut || exec.aborted) {
    return { available: false, reason: "docker info timed out" };
  }
  if (exec.exitCode !== 0) {
    const line = exec.stderr.trim().split("\n")[0] || "";
    return {
      available: false,
      reason: (line || `docker info exited ${exec.exitCode}`).slice(0, 200),
    };
  }
  return { available: true };
}

/**
 * Run act through the core runner. Returns the raw execution when the process
 * ran (any exit code); only BinaryNotFound/Timeout/truncated/runner errors
 * fail here so callers can interpret workflow exit codes themselves.
 */
async function execAct(
  ctx: ToolContext,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<
  { ok: true; exec: ExecutionResult } | { ok: false; result: ToolResult }
> {
  const binary = resolveActBinary();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const runtime = runtimeDir();
  let exec: ExecutionResult;
  try {
    exec = await ctx.run({
      binary,
      // -C points act at the project; cwd stays neutral so a repo `.actrc`
      // cannot inject flags, and HOME/USERPROFILE are neutralized so the
      // user/CI home `.actrc` is ignored too.
      args: ["-C", ctx.workspaceRoot, ...args],
      cwd: runtime,
      env: { HOME: runtime, USERPROFILE: runtime },
      timeoutMs,
      maxOutputBytes: 10 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, result: toolFailure(`act runner threw: ${String(err)}`) };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (exec.timedOut || exec.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "act timed out",
        error: {
          code: "Timeout",
          message: `act exceeded the ${timeoutMs}ms execution timeout`,
        },
      },
    };
  }
  // Truncation alone must NOT turn a passing run into a failure: the run tools
  // interpret exitCode below. A truncated PASSING run stays ok:true (raw is
  // already capped by the runner); only a truncated failing run fails here.
  if (exec.truncated && exec.exitCode !== 0) {
    return {
      ok: false,
      result: toolFailure(
        `act output exceeded the 10 MiB cap and the run failed (exit code ${exec.exitCode})`,
      ),
    };
  }
  if (exec.error) {
    return { ok: false, result: toolFailure(exec.error.message) };
  }
  return { ok: true, exec };
}

function firstErrorLine(exec: ExecutionResult): string {
  const line =
    exec.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
    exec.stdout.trim().split("\n").find((l) => l.trim() !== "") ??
    `exit code ${exec.exitCode}`;
  return line.slice(0, 300);
}

interface ParsedList {
  workflows: string[];
  jobs: { id: string; name: string; workflow: string }[];
}

/** Parse `act -l`'s table into workflows and jobs. */
function parseList(stdout: string): ParsedList {
  const rows: {
    jobId: string;
    jobName: string;
    workflowName: string;
    workflowFile: string;
  }[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\s+$/g, "");
    if (!line || /^Stage\s/.test(line)) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) continue;
    const jobId = parts[1];
    const jobName = parts[2];
    const workflowName = parts[3];
    const workflowFile = parts[4];
    if (!jobId || !jobName || !workflowName || !workflowFile) continue;
    rows.push({ jobId, jobName, workflowName, workflowFile });
  }
  const workflows: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.workflowName}|${r.workflowFile}`;
    if (!seen.has(key)) {
      seen.add(key);
      workflows.push(r.workflowName);
    }
  }
  return {
    workflows,
    jobs: rows.map((r) => ({
      id: r.jobId,
      name: r.jobName,
      workflow: r.workflowName,
    })),
  };
}

interface ParsedFailures {
  failedSteps: string[];
  failedJobs: string[];
  errors: string[];
}

/**
 * Parse act run/dry-run output for failures. Matches act's textual markers
 * ("❌ Failure - <step>", "🏁 Job failed", "Error: ...") using the ASCII
 * substrings so parsing is robust across consoles/encodings.
 */
function parseFailures(log: string): ParsedFailures {
  const failedSteps: string[] = [];
  const failedJobs: string[] = [];
  const errors: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (/Failure - /.test(line)) {
      const m = line.match(/Failure - (.+)$/);
      if (m && m[1]) failedSteps.push(m[1].trim());
    } else if (/Job failed/.test(line)) {
      const m = line.match(/\[([^\]]+)\]/);
      failedJobs.push(m && m[1] ? m[1].trim() : line);
    } else if (/^Error:/i.test(line)) {
      errors.push(line.replace(/^Error:\s*/i, "").trim());
    }
  }
  return {
    failedSteps: [...new Set(failedSteps)].filter(Boolean),
    failedJobs: [...new Set(failedJobs)].filter(Boolean),
    errors: [...new Set(errors)].filter(Boolean),
  };
}

function failureSummaryText(f: ParsedFailures): string {
  const parts: string[] = [];
  if (f.failedJobs.length > 0) {
    parts.push(`${f.failedJobs.length} job(s) failed: ${f.failedJobs.join(", ")}`);
  }
  if (f.failedSteps.length > 0) {
    parts.push(`${f.failedSteps.length} failed step(s): ${f.failedSteps.join(", ")}`);
  }
  if (f.errors.length > 0) {
    parts.push(`error(s): ${f.errors.slice(0, 3).join(" | ")}`);
  }
  return parts.join("; ") || "no failures detected";
}

const actListWorkflows: ToolDefinition = {
  name: "act_list_workflows",
  description:
    "List the GitHub Actions workflows act would run in the workspace (read; `act -l` works without Docker).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const ran = await execAct(ctx, ["-l"], { timeoutMs: 60_000 });
    if (!ran.ok) return ran.result;
    if (ran.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(ran.exec));
    }
    const parsed = parseList(ran.exec.stdout);
    const names = parsed.workflows.join(", ");
    return okResult(
      `${parsed.workflows.length} workflow(s)${names ? `: ${names}` : ""}`,
      ran.exec.stdout,
    );
  },
};

const actListJobs: ToolDefinition = {
  name: "act_list_jobs",
  description:
    "List the jobs act would run across the workspace's workflows (read; `act -l` works without Docker).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const ran = await execAct(ctx, ["-l"], { timeoutMs: 60_000 });
    if (!ran.ok) return ran.result;
    if (ran.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(ran.exec));
    }
    const parsed = parseList(ran.exec.stdout);
    const ids = parsed.jobs.map((j) => j.id).join(", ");
    return okResult(
      `${parsed.jobs.length} job(s) across ${parsed.workflows.length} workflow(s)${
        ids ? `: ${ids}` : ""
      }`,
      ran.exec.stdout,
    );
  },
};

const actDryRun: ToolDefinition = {
  name: "act_dry_run",
  description:
    "Dry-run the workspace's workflows with act (`act -n`), printing the execution plan without running steps (process).",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const docker = await detectDocker(ctx);
    if (!docker.available) {
      return dockerUnavailable(docker.reason ?? "unknown");
    }
    const ran = await execAct(ctx, ["-n", ...PLATFORM_FLAGS], {
      timeoutMs: 300_000,
    });
    if (!ran.ok) return ran.result;
    if (ran.exec.exitCode !== 0) {
      const f = parseFailures(ran.exec.stdout + "\n" + ran.exec.stderr);
      return toolFailure(
        f.failedJobs.length > 0
          ? `dry-run failed: ${failureSummaryText(f)}`
          : firstErrorLine(ran.exec),
      );
    }
    const plan = ran.exec.stdout.trim().split("\n").filter(Boolean);
    return okResult(
      `dry-run ok: ${plan.length} plan line(s)`,
      ran.exec.stdout,
    );
  },
};

const actRun: ToolDefinition = {
  name: "act_run",
  description:
    "Run all workflows in the workspace with act (system-change: executes containers / changes state outside the workspace; requires permission approval and Docker).",
  mutationClass: "system-change",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (
      !assertPermission("system-change", ctx.permission ?? { approved: false })
    ) {
      return permissionDenied();
    }
    const docker = await detectDocker(ctx);
    if (!docker.available) {
      return dockerUnavailable(docker.reason ?? "unknown");
    }
    const ran = await execAct(ctx, [...PLATFORM_FLAGS], { timeoutMs: 600_000 });
    if (!ran.ok) return ran.result;
    if (ran.exec.exitCode !== 0) {
      const f = parseFailures(ran.exec.stdout + "\n" + ran.exec.stderr);
      return toolFailure(failureSummaryText(f));
    }
    return okResult("all workflows passed", ran.exec.stdout);
  },
};

const actRunJob: ToolDefinition = {
  name: "act_run_job",
  description:
    "Run a single job (by job id from `act -l`) with act (system-change: executes containers / changes state outside the workspace; requires permission approval and Docker).",
  mutationClass: "system-change",
  inputSchema: {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        description: "job id to run, e.g. test",
      },
    },
    required: ["jobId"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { jobId } = validated.value as { jobId: string };
    if (typeof jobId !== "string" || jobId === "" || jobId.trim().startsWith("-")) {
      return invalid("jobId must be a non-empty job id");
    }
    if (
      !assertPermission("system-change", ctx.permission ?? { approved: false })
    ) {
      return permissionDenied();
    }
    const docker = await detectDocker(ctx);
    if (!docker.available) {
      return dockerUnavailable(docker.reason ?? "unknown");
    }
    const ran = await execAct(ctx, ["-j", jobId.trim(), ...PLATFORM_FLAGS], {
      timeoutMs: 600_000,
    });
    if (!ran.ok) return ran.result;
    if (ran.exec.exitCode !== 0) {
      const f = parseFailures(ran.exec.stdout + "\n" + ran.exec.stderr);
      return toolFailure(`job ${jobId} failed: ${failureSummaryText(f)}`);
    }
    return okResult(`job ${jobId} passed`, ran.exec.stdout);
  },
};

const actFailureSummary: ToolDefinition = {
  name: "act_failure_summary",
  description:
    "Summarize failures from act output (pass the log produced by act_run/act_dry_run as `log`). Read-only parser, no binary required.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      log: {
        type: "string",
        description: "act stdout+stderr log to analyze for failures",
      },
    },
    required: ["log"],
  },
  async execute(args, ctx) {
    void ctx; // act_failure_summary is a pure parser; no runner access needed.
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { log } = validated.value as { log: string };
    if (typeof log !== "string") {
      return invalid("log must be a string");
    }
    const f = parseFailures(log);
    return okResult(failureSummaryText(f), log);
  },
};

export const actPlugin: {
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
    name: "@dsh-forge/plugin-act",
    version: "0.1.0",
    upstreamTool: "act",
    coreContractVersion: "0.1.0",
    capabilities: [
      "list",
      "dry-run",
      "run",
      "failure-summary",
      "docker-detection",
    ],
  },
  tools: [
    actListWorkflows,
    actListJobs,
    actDryRun,
    actRun,
    actRunJob,
    actFailureSummary,
  ],
};

export { resolveActBinary };
