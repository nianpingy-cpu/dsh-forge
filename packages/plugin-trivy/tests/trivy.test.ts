import { describe, expect, it, beforeAll } from "vitest";
import {
  mkdtempSync,
  cpSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { trivyPlugin, resolveTrivyBinary } from "@dsh-forge/plugin-trivy";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/trivy", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-trivy-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

async function trivyRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  const result = await runProcess(req);
  if (result.error?.code === "BinaryNotFound") {
    if (req.cwd && existsSync(req.cwd)) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Results: [] }),
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

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

function jsonRunner(fixtureFile: string): ExecutionRunner {
  const content = readFileSync(join(FIXTURES, "json", fixtureFile), "utf8");
  return async () => ({
    exitCode: 0,
    stdout: content,
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 1,
  });
}

let hasRealTrivy = false;
try {
  hasRealTrivy = statSync(resolveTrivyBinary()).isFile();
} catch {
  // not installed
}

describe("resolveTrivyBinary", () => {
  it("resolves the trivy binary from PATH", () => {
    expect(resolveTrivyBinary()).toBeTruthy();
  });

  it("never returns a bare name (always absolute)", () => {
    expect(isAbsolute(resolveTrivyBinary())).toBe(true);
  });

  it("uses an unpredictable absolute sentinel when trivy is absent", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "dsh-empty-" + randomUUID());
      const a = resolveTrivyBinary();
      const b = resolveTrivyBinary();
      expect(isAbsolute(a)).toBe(true);
      expect(a).not.toBe("trivy");
      expect(a).not.toBe(b);
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("trivy_repo_scan", () => {
  const tool = () => trivyPlugin.tools.find((t) => t.name === "trivy_repo_scan")!;

  it("parses vulnerability findings from committed JSON", async () => {
    const result = await tool().execute(
      { repo: "fixtures/trivy" },
      ctx(jsonRunner("vuln-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1 vuln finding(s)");
    const d = (result.diagnostics ?? [])[0]!;
    expect(d.rule).toBe("vuln:CVE-2024-1234");
    expect(d.severity).toBe("error");
    expect(d.message).toContain("bash");
  });

  it("denies without permission approval (network)", async () => {
    const result = await tool().execute({ repo: "x" }, ctx(trivyRunner, false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("sanitizes embedded credentials in failure messages", async () => {
    const failRunner: ExecutionRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "FATAL repository https://TOKEN123@github.com/org/repo.git: not found",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { repo: "https://TOKEN123@github.com/org/repo.git" },
      ctx(failRunner),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).not.toContain("TOKEN123");
    expect(result.error?.message).toContain("***@");
  });

  it("rejects an empty or leading-dash repo", async () => {
    const a = await tool().execute({ repo: "" }, ctx(trivyRunner));
    const b = await tool().execute({ repo: "--help" }, ctx(trivyRunner));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("redacts secret Match and Code line content from raw output", async () => {
    const withSecrets = JSON.stringify({
      Results: [
        {
          Target: "repo",
          Class: "secret",
          Secrets: [
            {
              RuleID: "aws-access-key-id",
              Severity: "CRITICAL",
              Title: "AWS Access Key ID",
              Match: "AKIA5K4D3X7Q2T9P0Z1W",
              Code: {
                Lines: [
                  {
                    Number: 2,
                    Content: "aws_access_key_id=AKIA5K4D3X7Q2T9P0Z1W",
                    IsCause: true,
                    Highlighted: "aws_access_key_id=AKIA5K4D3X7Q2T9P0Z1W",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: withSecrets,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute(
      { repo: "https://github.com/foo/bar.git" },
      ctx(mock),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toBeTruthy();
    expect(result.raw).not.toContain("AKIA5K4D3X7Q2T9P0Z1W");
    expect(result.raw).toContain("[REDACTED]");
  });

  it("rejects a repo path that escapes the workspace", async () => {
    const result = await tool().execute({ repo: "../outside-repo" }, ctx(trivyRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("passes remote URLs through and resolves local paths in-workspace", async () => {
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Results: [] }),
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const url = await tool().execute(
      { repo: "https://github.com/foo/bar.git" },
      ctx(captureRunner),
    );
    expect(url.ok).toBe(true);
    expect(captured!.args[captured!.args.length - 1]).toBe(
      "https://github.com/foo/bar.git",
    );
    const local = await tool().execute({ repo: "fixtures/trivy" }, ctx(captureRunner));
    expect(local.ok).toBe(true);
    const lastArg = captured!.args[captured!.args.length - 1]!;
    expect(isAbsolute(lastArg)).toBe(true);
    expect(lastArg.startsWith(workspaceRoot)).toBe(true);
  });
});

describe("trivy_config_scan", () => {
  const tool = () =>
    trivyPlugin.tools.find((t) => t.name === "trivy_config_scan")!;

  it("parses misconfiguration findings from committed JSON", async () => {
    const result = await tool().execute(
      { path: "config" },
      ctx(jsonRunner("config-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1 misconfig finding(s)");
    const d = (result.diagnostics ?? [])[0]!;
    expect(d.rule).toBe("misconfig:DS002");
    expect(d.severity).toBe("error");
    expect(d.line).toBe(4);
  });

  it("denies without permission approval (network)", async () => {
    const result = await tool().execute({ path: "config" }, ctx(trivyRunner, false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("rejects a path outside the workspace", async () => {
    const result = await tool().execute({ path: "../outside" }, ctx(trivyRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects a leading-dash path (flag injection)", async () => {
    const result = await tool().execute(
      { path: "--cache-dir=outside" },
      ctx(trivyRunner),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("redacts misconfig CauseMetadata code lines from raw output", async () => {
    const report = JSON.stringify({
      Results: [
        {
          Target: "Dockerfile",
          Class: "config",
          Misconfigurations: [
            {
              ID: "DS-0002",
              Severity: "HIGH",
              Title: "root user",
              CauseMetadata: {
                StartLine: 4,
                Code: {
                  Lines: [
                    {
                      Number: 4,
                      Content:
                        "ENV AWS_ACCESS_KEY_ID=AKIA5K4D3X7Q2T9P0Z1W",
                      Highlighted: "AKIA5K4D3X7Q2T9P0Z1W",
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: report,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ path: "config" }, ctx(mock));
    expect(result.ok).toBe(true);
    expect(result.raw).toBeTruthy();
    expect(result.raw).not.toContain("AKIA5K4D3X7Q2T9P0Z1W");
    expect(result.raw).toContain("[REDACTED]");
  });

  it("maps trivy severities explicitly (MEDIUM->warning, LOW->info, UNKNOWN->info)", async () => {
    const report = JSON.stringify({
      Results: [
        {
          Target: "x",
          Misconfigurations: [
            { ID: "M", Severity: "MEDIUM", Title: "medium one" },
            { ID: "L", Severity: "LOW", Title: "low one" },
          ],
          Licenses: [{ Name: "MIT", Severity: "UNKNOWN", PkgName: "p" }],
        },
      ],
    });
    const mock: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: report,
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({ path: "config" }, ctx(mock));
    expect(result.ok).toBe(true);
    const diags = result.diagnostics ?? [];
    expect(diags[0]!.severity).toBe("warning"); // MEDIUM
    expect(diags[1]!.severity).toBe("info"); // LOW
    expect(diags[2]!.severity).toBe("info"); // UNKNOWN license
  });
});

describe("trivy_secret_scan", () => {
  const tool = () =>
    trivyPlugin.tools.find((t) => t.name === "trivy_secret_scan")!;

  it("parses secret findings from committed JSON", async () => {
    const result = await tool().execute(
      { path: "secrets" },
      ctx(jsonRunner("secret-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 secret finding(s)");
    const diags = result.diagnostics ?? [];
    expect(diags[0]!.rule).toBe("secret:aws-access-key-id");
    expect(diags[0]!.severity).toBe("critical");
    expect(diags[0]!.line).toBe(2);
    expect(diags[1]!.rule).toBe("secret:password");
  });

  it("never surfaces raw output (plaintext secret values not leaked)", async () => {
    const result = await tool().execute(
      { path: "secrets" },
      ctx(jsonRunner("secret-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AKIA5K4D3X7Q2T9P0Z1W");
    expect(serialized).not.toContain("superSecret123");
  });

  it("scans the committed secrets fixture with real trivy (offline)", async () => {
    if (!hasRealTrivy) return;
    const result = await tool().execute(
      { path: "secrets" },
      ctx(trivyRunner),
    );
    expect(result.ok).toBe(true);
    const diags = result.diagnostics ?? [];
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.rule === "secret:aws-access-key-id")).toBe(true);
  }, 30_000);

  it("rejects a path outside the workspace", async () => {
    const result = await tool().execute({ path: "../outside" }, ctx(trivyRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects a leading-dash path (flag injection)", async () => {
    const result = await tool().execute({ path: "--exit-code=1" }, ctx(trivyRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("runs trivy from a neutral runtime cwd (repo .trivyignore cannot suppress findings)", async () => {
    let captured: ExecutionRequest | undefined;
    const captureRunner: ExecutionRunner = async (req) => {
      captured = req;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Results: [] }),
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const result = await tool().execute({ path: "secrets" }, ctx(captureRunner));
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured!.cwd).not.toBe(workspaceRoot);
    expect(captured!.cwd).toMatch(/dsh-trivy-runtime-/);
  });
});

describe("trivy_image_scan", () => {
  const tool = () =>
    trivyPlugin.tools.find((t) => t.name === "trivy_image_scan")!;

  it("parses vulnerability findings from committed JSON", async () => {
    const result = await tool().execute(
      { image: "alpine:3.19" },
      ctx(jsonRunner("vuln-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1 vuln finding(s)");
  });

  it("denies without permission approval (network)", async () => {
    const result = await tool().execute({ image: "x" }, ctx(trivyRunner, false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });
});

describe("trivy_sbom", () => {
  const tool = () => trivyPlugin.tools.find((t) => t.name === "trivy_sbom")!;

  it("parses SBOM findings from the committed report JSON", async () => {
    // `trivy sbom --format json` emits trivy's report shape (licenses/vulns),
    // which is exactly what fixtures/trivy/json/sbom-report.json records.
    const result = await tool().execute(
      { path: "sbom/cyclonedx.json" },
      ctx(jsonRunner("sbom-report.json")),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 license finding(s)");
    const diags = result.diagnostics ?? [];
    expect(diags[0]!.rule).toBe("license:MIT");
    expect(diags[1]!.rule).toBe("license:GPL-3.0");
  });

  it("denies without permission approval (network)", async () => {
    const result = await tool().execute({ path: "sbom" }, ctx(trivyRunner, false));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("rejects a leading-dash path (flag injection)", async () => {
    const result = await tool().execute(
      { path: "--format=table" },
      ctx(trivyRunner),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });
});

describe("default export", () => {
  it("exports a default Plugin object (Plugin Standard)", async () => {
    const mod = await import("@dsh-forge/plugin-trivy");
    const def = (mod as { default?: { metadata?: unknown; tools?: unknown } }).default;
    expect(def).toBeTruthy();
    expect((def as { metadata: { name: string } }).metadata.name).toBe(
      "@dsh-forge/plugin-trivy",
    );
    expect(Array.isArray((def as { tools: unknown[] }).tools)).toBe(true);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const routing: ExecutionRunner = async (req) => {
      if (req.args.includes("--scanners")) {
        return {
          exitCode: 0,
          stdout: readFileSync(join(FIXTURES, "json", "secret-report.json"), "utf8"),
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      }
      if (req.args[0] === "config") {
        return {
          exitCode: 0,
          stdout: readFileSync(join(FIXTURES, "json", "config-report.json"), "utf8"),
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      }
      if (req.args[0] === "sbom") {
        return {
          exitCode: 0,
          stdout: readFileSync(join(FIXTURES, "json", "sbom-report.json"), "utf8"),
          stderr: "",
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: readFileSync(join(FIXTURES, "json", "vuln-report.json"), "utf8"),
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    };
    const report = await runContractSuite(trivyPlugin, {
      workspaceRoot,
      runner: routing,
      // Read-only secret tool reaches ctx.run without a permission gate.
      missingBinaryTool: "trivy_secret_scan",
      missingBinaryToolArgs: { path: "secrets" },
      toolArgs: {
        trivy_repo_scan: {
          valid: { repo: "https://example.com/repo.git" },
          invalid: { repo: 42 },
        },
        trivy_config_scan: {
          valid: { path: "config" },
          invalid: { path: 42 },
        },
        trivy_secret_scan: {
          valid: { path: "secrets" },
          invalid: { path: 42 },
        },
        trivy_image_scan: {
          valid: { image: "alpine:3.19" },
          invalid: { image: 42 },
        },
        trivy_sbom: {
          valid: { path: "sbom/cyclonedx.json" },
          invalid: { path: 42 },
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
