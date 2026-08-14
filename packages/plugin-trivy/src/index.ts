/**
 * Trivy adapter (ISSUE-017) — vulnerability / misconfiguration / secret /
 * license / SBOM scanning.
 *
 * Typed tools compiled to trivy argv[] — no shell, no free-form commands.
 * Each tool tags its findings with a result-type prefix so the model can
 * distinguish vulnerability / misconfiguration / secret / license / SBOM:
 *   trivy_repo_scan     (network)  trivy repo --format json <repo>
 *   trivy_config_scan   (network)  trivy config --format json <dir>
 *   trivy_secret_scan   (read)     trivy fs --scanners secret --format json <dir>
 *   trivy_image_scan    (network)  trivy image --format json <image>
 *   trivy_sbom          (network)  trivy sbom --format json <sbom-file>
 *
 * Parser tests are stable offline against committed JSON fixtures; live scans
 * (which download the vulnerability DB / policy bundle) are opt-in.
 */
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  toDiagnostic,
  normalizeSeverity,
  parseJsonOutput,
  summarizeDiagnostics,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type Diagnostic,
  type Severity,
} from "@dsh-forge/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTrivyBinary, TRIVY_BINARY_HINT } from "./binary.js";

const TOOL = "trivy";

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
    summary: `trivy binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: TRIVY_BINARY_HINT },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "trivy failed",
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
        "this tool may perform network access (vulnerability DB / policy bundle / image pull) and requires permission approval",
    },
  };
}

function parseFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "trivy produced unparseable output",
    error: { code: "ParseFailure", message },
  };
}

function toRelativeFile(
  workspaceRoot: string,
  file: string | undefined,
): string | undefined {
  if (!file) return undefined;
  return file.startsWith(workspaceRoot)
    ? file.slice(workspaceRoot.length + 1)
    : file;
}

function resolveInsideWorkspace(
  workspaceRoot: string,
  target: string,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  try {
    const absolute = resolveInWorkspace(workspaceRoot, target);
    return { ok: true, absolute };
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: {
            code: "WorkspaceViolation",
            message: `rejected: ${target}`,
          },
        },
      };
    }
    throw err;
  }
}

async function runTrivy(
  ctx: ToolContext,
  args: readonly string[],
): Promise<
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; result: ToolResult }
> {
  const binary = resolveTrivyBinary();
  // Run trivy from a fresh random runtime dir (never the workspace cwd): trivy
  // reads .trivyignore/.trivyignore.yaml from its process working directory,
  // so a repo-planted ignore file could silently suppress findings. Targets
  // are always absolute (or remote URLs), so the neutral cwd does not affect
  // what is scanned.
  const runtime = mkdtempSync(join(tmpdir(), "dsh-trivy-runtime-"));
  const execution = await ctx.run({
    binary,
    args: [...args],
    cwd: runtime,
    timeoutMs: 300_000,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (execution.timedOut || execution.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "trivy timed out",
        error: { code: "Timeout", message: "trivy exceeded the 300000ms timeout" },
      },
    };
  }
  if (execution.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "trivy output exceeded the output cap",
        error: {
          code: "ToolFailure",
          message:
            "trivy output exceeded the 20 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  return {
    ok: true,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode ?? 0,
  };
}

interface TrivyReport {
  Results?: TrivyResult[];
}

interface TrivyResult {
  Target?: unknown;
  Class?: unknown;
  Vulnerabilities?: TrivyVuln[];
  Misconfigurations?: TrivyMisconfig[];
  Secrets?: TrivySecret[];
  Licenses?: TrivyLicense[];
}

interface TrivyVuln {
  VulnerabilityID?: unknown;
  PkgName?: unknown;
  InstalledVersion?: unknown;
  FixedVersion?: unknown;
  Title?: unknown;
  Severity?: unknown;
  PrimaryURL?: unknown;
}

interface TrivyMisconfig {
  ID?: unknown;
  AVDID?: unknown;
  Title?: unknown;
  Severity?: unknown;
  Message?: unknown;
  Status?: unknown;
  StartLine?: unknown;
  EndLine?: unknown;
  CauseMetadata?: { StartLine?: unknown; EndLine?: unknown };
  Resolution?: unknown;
}

interface TrivySecret {
  RuleID?: unknown;
  Category?: unknown;
  Severity?: unknown;
  Title?: unknown;
  StartLine?: unknown;
  EndLine?: unknown;
  Match?: unknown;
}

interface TrivyLicense {
  Name?: unknown;
  Severity?: unknown;
  PkgName?: unknown;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Explicit trivy severity mapping. trivy emits CRITICAL/HIGH/MEDIUM/LOW/
 * UNKNOWN, which core normalizeSeverity would otherwise collapse to 'error';
 * this keeps a LOW vuln distinguishable from a HIGH one and maps UNKNOWN
 * (common in license reports) to info.
 */
function trivySeverity(input: unknown): Severity {
  if (typeof input === "string") {
    switch (input.trim().toUpperCase()) {
      case "CRITICAL":
        return "critical";
      case "HIGH":
        return "error";
      case "MEDIUM":
        return "warning";
      case "LOW":
        return "info";
      case "UNKNOWN":
        return "info";
      default:
        return normalizeSeverity(input);
    }
  }
  return normalizeSeverity(input);
}

/** Reject empty or leading-dash path inputs (flag injection). */
function isValidPathInput(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !/^\s*-/.test(path);
}

function parseReport(run: {
  ok: true;
  stdout: string;
}): { ok: true; report: TrivyReport } | { ok: false; result: ToolResult } {
  const parsed = parseJsonOutput(TOOL, run.stdout);
  if (!parsed.ok) return { ok: false, result: parseFailure(parsed.error) };
  const data = parsed.value as Record<string, unknown>;
  if (typeof data !== "object" || data === null) {
    return { ok: false, result: parseFailure("trivy: expected a JSON object") };
  }
  return { ok: true, report: data as unknown as TrivyReport };
}

/** Convert trivy findings of one class into Diagnostics with a type tag. */
function findingsToDiagnostics(
  workspaceRoot: string,
  results: TrivyResult[],
  type: "vulnerability" | "misconfiguration" | "secret" | "license",
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of results) {
    const file = toRelativeFile(
      workspaceRoot,
      str(r.Target),
    );
    for (const v of r.Vulnerabilities ?? []) {
      out.push(
        toDiagnostic(TOOL, {
          severity: trivySeverity(v.Severity),
          rule: str(v.VulnerabilityID)
            ? `vuln:${str(v.VulnerabilityID)}`
            : `vuln:${type}`,
          file,
          message: str(v.Title) ?? `vulnerability in ${str(v.PkgName) ?? "?"}`,
          suggestion: str(v.FixedVersion)
            ? `fixed in ${str(v.FixedVersion)}`
            : undefined,
          fixable: false,
        }),
      );
    }
    for (const m of r.Misconfigurations ?? []) {
      out.push(
        toDiagnostic(TOOL, {
          severity: trivySeverity(m.Severity),
          rule: str(m.ID) ? `misconfig:${str(m.ID)}` : `misconfig:${type}`,
          file,
          line:
            num(m.StartLine) ?? num(m.CauseMetadata?.StartLine),
          column: undefined,
          message: str(m.Title) ?? str(m.Message) ?? "misconfiguration",
          suggestion: str(m.Resolution),
          fixable: false,
        }),
      );
    }
    for (const s of r.Secrets ?? []) {
      out.push(
        toDiagnostic(TOOL, {
          severity: trivySeverity(s.Severity),
          rule: str(s.RuleID) ? `secret:${str(s.RuleID)}` : `secret:${type}`,
          file,
          line: num(s.StartLine),
          column: undefined,
          message: str(s.Title) ?? `secret (${str(s.Category) ?? "unknown"})`,
          suggestion: undefined,
          fixable: false,
        }),
      );
    }
    for (const l of r.Licenses ?? []) {
      out.push(
        toDiagnostic(TOOL, {
          severity: trivySeverity(l.Severity),
          rule: str(l.Name) ? `license:${str(l.Name)}` : `license:${type}`,
          file,
          message: `license ${str(l.Name) ?? "?"} on ${str(l.PkgName) ?? "?"}`,
          suggestion: undefined,
          fixable: false,
        }),
      );
    }
  }
  return out;
}

/**
 * Redact plaintext secret values from a trivy report JSON so raw output never
 * leaks secrets to the model/logs. Covers Secrets[].Match AND Secrets[].Code
 * line Content/Highlighted (the matched source line trivy embeds), plus the
 * whole Code block as a belt-and-suspenders guard. Non-JSON text passes
 * through unchanged (trivy --format json is always JSON, so this is a guard).
 */
function redactReportSecrets(text: string): string {
  try {
    const data = JSON.parse(text) as { Results?: TrivyResult[] };
    let changed = false;
    for (const r of data.Results ?? []) {
      for (const s of r.Secrets ?? []) {
        const rec = s as {
          Match?: unknown;
          Code?: {
            Lines?: { Content?: unknown; Highlighted?: unknown }[];
          };
        };
        if (rec.Match !== undefined) {
          rec.Match = "[REDACTED]";
          changed = true;
        }
        for (const line of rec.Code?.Lines ?? []) {
          if (line.Content !== undefined) {
            line.Content = "[REDACTED]";
            changed = true;
          }
          if (line.Highlighted !== undefined) {
            line.Highlighted = "[REDACTED]";
            changed = true;
          }
        }
        if (rec.Code !== undefined) {
          rec.Code = { Lines: [{ Content: "[REDACTED]" }] };
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(data) : text;
  } catch {
    return text;
  }
}

/**
 * Summarize diagnostics grouped by their result-type rule prefix
 * (vuln:/misconfig:/secret:/license:/sbom:) so mixed-class reports are labeled
 * accurately (e.g. a repo scan that only finds secrets says "N secret
 * finding(s)", not "N vulnerability finding(s)").
 */
function summaryFromDiagnostics(diagnostics: Diagnostic[]): string {
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    const cls = d.rule?.split(":")[0] ?? "finding";
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cls, n]) => `${n} ${cls} finding(s)`)
    .join(", ");
}

function reportResult(
  workspaceRoot: string,
  run: { ok: true; stdout: string },
  type: "vulnerability" | "misconfiguration" | "secret" | "license",
  okSummary: string,
  opts?: { includeRaw?: boolean },
): ToolResult {
  const parsed = parseReport(run);
  if (!parsed.ok) return parsed.result;
  const diagnostics = findingsToDiagnostics(
    workspaceRoot,
    parsed.report.Results ?? [],
    type,
  );
  const includeRaw = opts?.includeRaw ?? true;
  const safeRaw = redactReportSecrets(run.stdout);
  return {
    ok: true,
    summary:
      diagnostics.length > 0
        ? summaryFromDiagnostics(diagnostics)
        : okSummary,
    diagnostics,
    summaryBlock:
      diagnostics.length > 0
        ? summarizeDiagnostics(TOOL, diagnostics)
        : undefined,
    raw:
      includeRaw && safeRaw.length > 20_000
        ? safeRaw.slice(0, 20_000) + "\n...[truncated]"
        : includeRaw
          ? safeRaw
          : undefined,
  };
}

/**
 * `trivy sbom --format json` emits trivy's own report JSON
 * (`{ ArtifactName, Results: [...] }`) — licenses/vulnerabilities found in the
 * scanned SBOM document — NOT a CycloneDX document. Parse the report shape
 * into Diagnostics tagged license:/vuln: (SBOM-derived findings).
 */
function sbomResult(
  workspaceRoot: string,
  run: { ok: true; stdout: string },
): ToolResult {
  const parsed = parseReport(run);
  if (!parsed.ok) return parsed.result;
  const diagnostics = findingsToDiagnostics(
    workspaceRoot,
    parsed.report.Results ?? [],
    "license",
  );
  return {
    ok: true,
    summary:
      diagnostics.length > 0
        ? summaryFromDiagnostics(diagnostics)
        : "no sbom findings",
    diagnostics,
    summaryBlock:
      diagnostics.length > 0
        ? summarizeDiagnostics(TOOL, diagnostics)
        : undefined,
    raw:
      run.stdout.length > 20_000
        ? run.stdout.slice(0, 20_000) + "\n...[truncated]"
        : run.stdout,
  };
}

const PATH_SCHEMA = {
  type: "string" as const,
  description: "workspace-relative path to scan",
};

const trivyRepoScan: ToolDefinition = {
  name: "trivy_repo_scan",
  description:
    "Scan a Git repository with trivy for vulnerabilities/misconfigurations/secrets. The repo may be a remote URL or a workspace-relative local path (network: downloads the vulnerability DB and may clone a remote repo).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string" as const,
        description: "Git repository URL or workspace-relative path to scan",
      },
    },
    required: ["repo"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { repo } = validated.value as { repo: string };
    if (typeof repo !== "string" || repo === "" || repo.trim().startsWith("-")) {
      return invalid("repo must be a non-empty repository URL or path");
    }
    let target = repo.trim();
    // Remote URLs scan the remote repo (that is the tool's purpose). Any
    // other value is a local path and must resolve inside the workspace so a
    // `../` or absolute path cannot read git repos outside the boundary
    // (ADR-005).
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(target)) {
      const resolved = resolveInsideWorkspace(ctx.workspaceRoot, target);
      if (!resolved.ok) return resolved.result;
      target = resolved.absolute;
    }
    const run = await runTrivy(ctx, [
      "repo",
      "--format",
      "json",
      "-q",
      target,
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    return reportResult(ctx.workspaceRoot, run, "vulnerability", "no vulnerabilities");
  },
};

const trivyConfigScan: ToolDefinition = {
  name: "trivy_config_scan",
  description:
    "Scan config/IaC files with trivy for misconfigurations (network: downloads the policy bundle on first run; use --skip-policy-update via local flags for offline runs).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { path } = validated.value as { path: string };
    if (!isValidPathInput(path)) {
      return invalid("path must be a non-empty workspace path");
    }
    const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
    if (!resolved.ok) return resolved.result;
    const run = await runTrivy(ctx, [
      "config",
      "--format",
      "json",
      "-q",
      resolved.absolute,
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    return reportResult(ctx.workspaceRoot, run, "misconfiguration", "no misconfigurations");
  },
};

const trivySecretScan: ToolDefinition = {
  name: "trivy_secret_scan",
  description:
    "Scan a workspace path for hardcoded secrets with trivy (read: the secret scanner is fully offline, no vulnerability DB required).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path } = validated.value as { path: string };
    if (!isValidPathInput(path)) {
      return invalid("path must be a non-empty workspace path");
    }
    const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
    if (!resolved.ok) return resolved.result;
    const run = await runTrivy(ctx, [
      "fs",
      "--scanners",
      "secret",
      "--format",
      "json",
      "-q",
      resolved.absolute,
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    // Secrets[].Match holds the plaintext secret values; never surface raw
    // output for the secret scanner (no leak to the model / logs).
    return reportResult(
      ctx.workspaceRoot,
      run,
      "secret",
      "no secrets found",
      { includeRaw: false },
    );
  },
};

const trivyImageScan: ToolDefinition = {
  name: "trivy_image_scan",
  description:
    "Scan a container image with trivy for vulnerabilities (network: downloads the vulnerability DB and may pull the image).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      image: {
        type: "string" as const,
        description: "container image reference, e.g. alpine:3.19",
      },
    },
    required: ["image"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { image } = validated.value as { image: string };
    if (typeof image !== "string" || image === "" || image.trim().startsWith("-")) {
      return invalid("image must be a non-empty image reference");
    }
    const run = await runTrivy(ctx, [
      "image",
      "--format",
      "json",
      "-q",
      image.trim(),
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    return reportResult(ctx.workspaceRoot, run, "vulnerability", "no vulnerabilities");
  },
};

const trivySbom: ToolDefinition = {
  name: "trivy_sbom",
  description:
    "Generate/scan an SBOM with trivy. With a CycloneDX JSON output this reports SBOM components (and, for `trivy sbom`, licenses/vulnerabilities) (network: may download the vulnerability/license DB).",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: { path: PATH_SCHEMA },
    required: ["path"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const { path } = validated.value as { path: string };
    if (!isValidPathInput(path)) {
      return invalid("path must be a non-empty workspace path");
    }
    const resolved = resolveInsideWorkspace(ctx.workspaceRoot, path);
    if (!resolved.ok) return resolved.result;
    const run = await runTrivy(ctx, [
      "sbom",
      "--format",
      "json",
      "-q",
      resolved.absolute,
    ]);
    if (!run.ok) return run.result;
    if (run.exitCode !== 0) {
      return toolFailure(
        run.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
          `exit code ${run.exitCode}`,
      );
    }
    return sbomResult(ctx.workspaceRoot, run);
  },
};

export const trivyPlugin: {
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
    name: "@dsh-forge/plugin-trivy",
    version: "0.1.0",
    upstreamTool: "trivy",
    coreContractVersion: "0.1.0",
    capabilities: [
      "repo-scan",
      "config-scan",
      "secret-scan",
      "image-scan",
      "sbom",
      "read-only-offline-secret",
    ],
  },
  tools: [
    trivyRepoScan,
    trivyConfigScan,
    trivySecretScan,
    trivyImageScan,
    trivySbom,
  ],
};

export { resolveTrivyBinary };

export default trivyPlugin;
