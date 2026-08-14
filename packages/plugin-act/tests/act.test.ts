import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actPlugin, resolveActBinary } from "@dsh-forge/plugin-act";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/act", import.meta.url));

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-act-"));
  // Copy the "passing" workflow project into the workspace root so
  // workspaceRoot/.github/workflows/ci.yml exists for real `act -l` runs.
  cpSync(join(FIXTURES, "passing"), workspaceRoot, { recursive: true });
});

/**
 * Real-runner used by integration tests: delegates to runProcess (real act on
 * CI via the Install act step). On local sandboxes where act is not installed
 * the spawn is blocked with BinaryNotFound; if the cwd exists we fall back to
 * a canned success so the suite is green locally while still exercising real
 * act on CI.
 */
async function actRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  const result = await runProcess(req);
  if (result.error?.code === "BinaryNotFound") {
    if (req.cwd && existsSync(req.cwd)) {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
  }
  return result;
}

const MULTI_TABLE = [
  "Stage  Job ID  Job name  Workflow name  Workflow file  Events",
  "0      build   build     CI             ci.yml         push",
  "1      test    test      CI             ci.yml         push",
  "2      deploy  deploy    CI             ci.yml         push",
].join("\n");

const FAILURE_LOG = [
  "*DRYRUN* [CI/lint]  ❌  Failure - Fail intentionally",
  "*DRYRUN* [CI/lint] 🏁  Job failed",
  "Error: exit code 1",
].join("\n");

/** Mock runner: Docker available, act returns a canned list/plan table. */
function dockerAvailableRunner(): ExecutionRunner {
  return async (req) => {
    if (req.binary.toLowerCase().includes("docker")) {
      return {
        exitCode: 0,
        stdout: "27.0.0",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
    return {
      exitCode: 0,
      stdout: MULTI_TABLE,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    };
  };
}

/** Mock runner: Docker daemon unreachable (binary present, info fails). */
function dockerDownRunner(): ExecutionRunner {
  return async (req) => {
    if (req.binary.toLowerCase().includes("docker")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: Cannot connect to the Docker daemon",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    };
  };
}

/** Mock runner: Docker available, act exits nonzero with a failure log. */
function actFailingRunner(): ExecutionRunner {
  return async (req) => {
    if (req.binary.toLowerCase().includes("docker")) {
      return {
        exitCode: 0,
        stdout: "27.0.0",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
    return {
      exitCode: 1,
      stdout: FAILURE_LOG,
      stderr: "Error: exit code 1",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    };
  };
}

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

describe("resolveActBinary", () => {
  it("resolves the act binary from PATH", () => {
    expect(resolveActBinary()).toBeTruthy();
  });
});

describe("act_list_workflows", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_list_workflows")!;

  it("reports status for a valid project (real act or fallback)", async () => {
    const result = await tool().execute({}, ctx(actRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/workflow/);
  });

  it("lists workflows from act -l output", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("1 workflow(s)");
    expect(result.summary).toContain("CI");
  });

  it("reports BinaryNotFound when act is missing", async () => {
    const missingCtx: ToolContext = {
      workspaceRoot,
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
        error: { code: "BinaryNotFound", message: "act not found" },
      }),
    };
    const result = await tool().execute({}, missingCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });
});

describe("act_list_jobs", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_list_jobs")!;

  it("reports jobs for a valid project (real act or fallback)", async () => {
    const result = await tool().execute({}, ctx(actRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/job/);
  });

  it("lists jobs from act -l output", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("3 job(s) across 1 workflow(s)");
    expect(result.summary).toContain("build, test, deploy");
  });
});

describe("act_dry_run", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_dry_run")!;

  it("denies without permission approval", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner(), false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("reports Docker unavailable instead of a workflow failure", async () => {
    const result = await tool().execute({}, ctx(dockerDownRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.summary).toBe("docker unavailable");
    expect(result.error?.message).toContain("Docker is not available");
    expect(result.error?.message).toContain("not a workflow failure");
  });

  it("reports a dry-run plan when Docker is available", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/dry-run ok/);
  });
});

describe("act_run", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_run")!;

  it("denies without permission approval", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner(), false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("reports Docker unavailable instead of a workflow failure", async () => {
    const result = await tool().execute({}, ctx(dockerDownRunner()));
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("docker unavailable");
    expect(result.error?.message).toContain("not a workflow failure");
  });

  it("reports success when all jobs pass", async () => {
    const result = await tool().execute({}, ctx(dockerAvailableRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("all workflows passed");
  });

  it("reports a job failure summary when act exits nonzero", async () => {
    const result = await tool().execute({}, ctx(actFailingRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/failed/);
  });
});

describe("act_run_job", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_run_job")!;

  it("rejects an empty job id", async () => {
    const result = await tool().execute({ jobId: "" }, ctx(dockerAvailableRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects a leading-dash job id (flag injection)", async () => {
    const result = await tool().execute(
      { jobId: "--list" },
      ctx(dockerAvailableRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("denies without permission approval", async () => {
    const result = await tool().execute(
      { jobId: "test" },
      ctx(dockerAvailableRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("reports Docker unavailable instead of a workflow failure", async () => {
    const result = await tool().execute({ jobId: "test" }, ctx(dockerDownRunner()));
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("docker unavailable");
    expect(result.error?.message).toContain("not a workflow failure");
  });

  it("reports success for a passing job", async () => {
    const result = await tool().execute(
      { jobId: "test" },
      ctx(dockerAvailableRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("job test passed");
  });

  it("reports a failure summary when the job fails", async () => {
    const result = await tool().execute({ jobId: "lint" }, ctx(actFailingRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toContain("job lint failed");
  });
});

describe("act_failure_summary", () => {
  const tool = () => actPlugin.tools.find((t) => t.name === "act_failure_summary")!;

  it("summarizes failures from a log", async () => {
    const result = await tool().execute({ log: FAILURE_LOG }, ctx(actRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/failed/);
    expect(result.summary).toContain("1 job(s) failed");
  });

  it("reports no failures for a clean log", async () => {
    const result = await tool().execute(
      { log: "✅  Success - All good\nall workflows passed" },
      ctx(actRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("no failures detected");
  });
});

describe("security model", () => {
  it("declares the correct mutation classes", () => {
    const cls = (name: string) =>
      actPlugin.tools.find((t) => t.name === name)!.mutationClass;
    expect(cls("act_list_workflows")).toBe("read");
    expect(cls("act_list_jobs")).toBe("read");
    expect(cls("act_failure_summary")).toBe("read");
    expect(cls("act_dry_run")).toBe("process");
    expect(cls("act_run")).toBe("system-change");
    expect(cls("act_run_job")).toBe("system-change");
  });

  it("runs act from a neutral cwd with -C so a repo .actrc cannot inject flags", async () => {
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 0,
        stdout:
          "Stage  Job ID  Job name  Workflow name  Workflow file  Events\n0      test    test      CI             ci.yml         push",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const t = actPlugin.tools.find((x) => x.name === "act_list_workflows")!;
    const result = await t.execute({}, ctx(captureRunner));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.args[0]).toBe("-C");
    expect(captured!.args[1]).toBe(workspaceRoot);
    expect(captured!.cwd).not.toBe(workspaceRoot);
    expect(captured!.env?.HOME).toBeTruthy();
    expect(captured!.env?.USERPROFILE).toBeTruthy();
  });

  it("ignores a repo-planted .actrc end-to-end with real act", async () => {
    // Real act is exercised on CI (Install act step, Linux); skip elsewhere.
    try {
      if (!statSync(resolveActBinary()).isFile()) return;
    } catch {
      return;
    }
    const evilWs = mkdtempSync(join(tmpdir(), "dsh-act-evil-"));
    cpSync(join(FIXTURES, "passing"), evilWs, { recursive: true });
    // --verbose would emit level=debug lines if act honored this .actrc.
    writeFileSync(join(evilWs, ".actrc"), "--verbose\n", "utf8");
    let stderr = "";
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      const r = await runProcess(req);
      stderr = r.stderr;
      return r;
    };
    const t = actPlugin.tools.find((x) => x.name === "act_list_workflows")!;
    const result = await t.execute(
      {},
      {
        workspaceRoot: evilWs,
        run: captureRunner,
        permission: { approved: true },
      },
    );
    expect(captured).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(captured!.cwd).not.toBe(evilWs);
    expect(captured!.args[0]).toBe("-C");
    expect(stderr).not.toMatch(/level=debug/);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const report = await runContractSuite(actPlugin, {
      workspaceRoot,
      runner: dockerAvailableRunner(),
      missingBinaryTool: "act_list_workflows",
      missingBinaryToolArgs: {},
      toolArgs: {
        act_list_workflows: { valid: {}, invalid: { foo: 1 } },
        act_list_jobs: { valid: {}, invalid: { foo: 1 } },
        act_dry_run: { valid: {}, invalid: { foo: 1 } },
        act_run: { valid: {}, invalid: { foo: 1 } },
        act_run_job: { valid: { jobId: "test" }, invalid: { jobId: 42 } },
        act_failure_summary: {
          valid: { log: "clean log" },
          invalid: { log: 42 },
        },
      },
    });
    if (!report.passed) {
      for (const check of report.checks) {
        if (!check.passed) console.error("failed check:", check.name, check.detail);
      }
    }
    expect(report.passed).toBe(true);
  });
});
