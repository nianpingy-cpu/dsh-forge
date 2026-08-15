/**
 * Quality / security gate (ISSUE-018) — orchestration only, no
 * reimplementation. The tool detects the project language, runs the matching
 * lint lane (Ruff for Python, Biome for JS/TS) plus the security lanes
 * (Semgrep audit, Trivy secrets) by composing the existing plugin tools,
 * aggregates their normalized diagnostics, and returns a
 * PASS / PASS_WITH_WARNINGS / FAIL verdict with configurable thresholds.
 *
 * Permission model (ADR-005, honest): the gate is classified `network` (it
 * runs the Semgrep audit lane), so invoking it requires network approval;
 * once approved, every lane runs. Lanes:
 * - A lane whose binary is not installed (BinaryNotFound) is recorded as
 *   "skipped" and does not fail the gate (other lanes still gate).
 * - A lane that errors for any other reason fails the gate (FAIL) — the gate
 *   cannot certify quality when a lane did not run.
 * - If no lane actually ran, the gate returns BinaryNotFound instead of
 *   fabricating a verdict.
 *
 * `quality_gate_status` (read) reports which lanes are available and the
 * detected project language; it is the ungated companion probe.
 */
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  summarizeDiagnostics,
  type Diagnostic,
  type ExecutionRequest,
  type Severity,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@dsh-forge/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ruffPlugin, resolveRuffBinary } from "@dsh-forge/plugin-ruff";
import { biomePlugin, resolveBiomeBinary } from "@dsh-forge/plugin-biome";
import { semgrepPlugin, resolveSemgrepBinary } from "@dsh-forge/plugin-semgrep";
import { trivyPlugin, resolveTrivyBinary } from "@dsh-forge/plugin-trivy";

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "quality gate failed",
    error: { code: "ToolFailure", message },
  };
}

function binaryNotFound(message: string): ToolResult {
  return {
    ok: false,
    summary: "no quality tools available",
    error: { code: "BinaryNotFound", message },
  };
}

/** Redact embedded credentials before a value reaches the model. */
function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/([A-Za-z0-9_.-]+):([^@\s/]+)@/g, "$1:***@");
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Reject empty / leading-dash / control-character paths (flag injection). */
function isValidPathInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !hasControlChars(value)
  );
}

// --- project detection (composition/config only) -------------------------

type ProjectLang = "python" | "web" | "generic";

function hasFile(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}

function hasAnyExt(dir: string, exts: readonly string[]): boolean {
  try {
    for (const entry of readdirSync(dir)) {
      if (exts.some((e) => entry.toLowerCase().endsWith(e))) return true;
    }
  } catch {
    // unreadable directory — treat as generic
  }
  return false;
}

/** Detect the dominant language of the gated directory by marker files. */
function detectLanguage(gateDir: string): ProjectLang {
  const pythonMarkers = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
  ];
  const python =
    pythonMarkers.some((f) => hasFile(gateDir, f)) ||
    hasAnyExt(gateDir, [".py"]);
  if (python) return "python";

  const webMarkers = ["package.json", "tsconfig.json", "jsconfig.json"];
  const web =
    webMarkers.some((f) => hasFile(gateDir, f)) ||
    hasAnyExt(gateDir, [".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs"]);
  if (web) return "web";

  return "generic";
}

// --- lanes (compose existing plugin tools) -------------------------------

interface Lane {
  name: string;
  tool: ToolDefinition;
  args: unknown;
}

const ruffCheck = ruffPlugin.tools.find((t) => t.name === "ruff_check")!;
const biomeCheck = biomePlugin.tools.find((t) => t.name === "biome_check")!;
const semgrepSecurityScan = semgrepPlugin.tools.find(
  (t) => t.name === "semgrep_security_scan",
)!;
const trivySecretScan = trivyPlugin.tools.find(
  (t) => t.name === "trivy_secret_scan",
)!;

function buildLanes(lang: ProjectLang, gateRel: string): Lane[] {
  const lanes: Lane[] = [];
  if (lang === "python") {
    lanes.push({ name: "ruff_check", tool: ruffCheck, args: { paths: [gateRel] } });
  }
  if (lang === "web") {
    lanes.push({ name: "biome_check", tool: biomeCheck, args: { paths: [gateRel] } });
  }
  // Security lanes run for every project type.
  lanes.push({ name: "trivy_secret_scan", tool: trivySecretScan, args: { path: gateRel } });
  lanes.push({ name: "semgrep_security_scan", tool: semgrepSecurityScan, args: { path: gateRel } });
  return lanes;
}

// --- verdict -----------------------------------------------------------------

type Verdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL";
type FailOn = "error" | "warning" | "any";

function countBySeverity(
  diagnostics: readonly Diagnostic[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  for (const d of diagnostics) {
    counts[d.severity] = (counts[d.severity] ?? 0) + 1;
  }
  return counts;
}

function computeVerdict(
  diagnostics: readonly Diagnostic[],
  failOn: FailOn,
  laneErrors: number,
): { verdict: Verdict; counts: Record<Severity, number> } {
  const counts = countBySeverity(diagnostics);
  const errors = counts.error + counts.critical;
  const warnings = counts.warning;
  if (laneErrors > 0) return { verdict: "FAIL", counts };
  let verdict: Verdict;
  if (failOn === "error") {
    if (errors > 0) verdict = "FAIL";
    else if (warnings > 0) verdict = "PASS_WITH_WARNINGS";
    else verdict = "PASS";
  } else if (failOn === "warning") {
    verdict = errors + warnings > 0 ? "FAIL" : "PASS";
  } else {
    verdict = diagnostics.length > 0 ? "FAIL" : "PASS";
  }
  return { verdict, counts };
}

interface LaneOutcome {
  name: string;
  status: "ok" | "skipped" | "error";
  findings: number;
  message?: string;
}

// --- tool --------------------------------------------------------------------

const qualityGate: ToolDefinition = {
  name: "quality_gate",
  description:
    "Detect the project (Python/JS/TS), run the matching lint lane (Ruff/Biome) plus security lanes (Semgrep audit, Trivy secrets) by composing the existing plugin tools, aggregate normalized diagnostics, and return a PASS / PASS_WITH_WARNINGS / FAIL verdict with configurable thresholds. Classified network: requires network approval (the Semgrep audit lane reaches the registry); once approved every lane runs. Lanes whose binary is not installed are skipped and reported; a lane that errors fails the gate.",
  mutationClass: "network",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "workspace-relative directory to gate (default: workspace root)",
      },
      failOn: {
        type: "string",
        enum: ["error", "warning", "any"],
        description: "lowest severity that fails the gate (default error)",
      },
      maxFindings: {
        type: "number",
        description: "cap on aggregated diagnostics in the result (default 200)",
      },
    },
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path, failOn, maxFindings } = validated.value as {
      path?: string;
      failOn?: FailOn;
      maxFindings?: number;
    };
    const threshold: FailOn = failOn ?? "error";
    const cap = maxFindings ?? 200;
    if (!Number.isInteger(cap) || cap < 1 || cap > 5000) {
      return invalid("maxFindings must be an integer between 1 and 5000");
    }
    // Honest ADR-005 gating: the gate is classified network (the Semgrep
    // audit lane reaches the registry), so the host must approve network
    // before any lane runs.
    if (!assertPermission("network", ctx.permission ?? { approved: false })) {
      return {
        ok: false,
        summary: "permission denied",
        error: {
          code: "PermissionDenied",
          message:
            "quality_gate runs a network security audit lane and requires network approval",
        },
      };
    }

    let gateRel: string;
    let gateAbs: string;
    if (path !== undefined) {
      if (!isValidPathInput(path)) {
        return invalid("path must be a non-empty workspace path");
      }
      try {
        gateAbs = resolveInWorkspace(ctx.workspaceRoot, path);
      } catch (err) {
        if (err instanceof WorkspaceViolationError) {
          return {
            ok: false,
            summary: "path escapes the workspace boundary",
            error: { code: "WorkspaceViolation", message: `rejected: ${path}` },
          };
        }
        return toolFailure(`path could not be resolved: ${String(err)}`);
      }
      gateRel = path;
    } else {
      gateAbs = resolveInWorkspace(ctx.workspaceRoot, ".");
      gateRel = ".";
    }

    const lanes = buildLanes(detectLanguage(gateAbs), gateRel);

    const diagnostics: Diagnostic[] = [];
    const outcomes: LaneOutcome[] = [];
    let laneErrors = 0;
    let ran = 0;
    for (const lane of lanes) {
      // A throwing composed tool (or a throw from ctx.run the tool does not
      // normalize) must never crash the gate: map it to a lane 'error'
      // outcome so the gate still returns a normalized verdict (FAIL).
      let result: ToolResult;
      try {
        result = await lane.tool.execute.call(lane.tool, lane.args, ctx);
      } catch (err) {
        ran += 1;
        laneErrors += 1;
        outcomes.push({
          name: lane.name,
          status: "error",
          findings: 0,
          message: String(err),
        });
        continue;
      }
      if (result.ok) {
        ran += 1;
        const ds = result.diagnostics ?? [];
        diagnostics.push(...ds);
        outcomes.push({ name: lane.name, status: "ok", findings: ds.length });
      } else if (result.error?.code === "BinaryNotFound") {
        outcomes.push({
          name: lane.name,
          status: "skipped",
          findings: 0,
          message: result.error.message,
        });
      } else {
        ran += 1;
        laneErrors += 1;
        outcomes.push({
          name: lane.name,
          status: "error",
          findings: 0,
          message: result.error?.message ?? result.summary,
        });
      }
    }

    if (ran === 0) {
      return binaryNotFound(
        "no quality tools available (Ruff/Biome, Semgrep, Trivy not installed or unusable)",
      );
    }

    // The verdict and counts are computed on ALL findings — never on the
    // truncated slice — so a security finding past maxFindings still fails
    // the gate (only the returned diagnostics are capped for the model).
    const capped = diagnostics.slice(0, cap);
    const truncated = diagnostics.length > cap;
    const { verdict, counts } = computeVerdict(
      diagnostics,
      threshold,
      laneErrors,
    );

    const laneSummary = outcomes
      .filter((o) => o.status !== "ok" || o.findings > 0)
      .map((o) =>
        o.status === "ok"
          ? `${o.name}:${o.findings}`
          : `${o.name}:${o.status}`,
      )
      .join(", ");

    const summary =
      `quality gate: ${verdict} — ${counts.error + counts.critical} error(s), ` +
      `${counts.warning} warning(s) across ${outcomes.length} lane(s)` +
      (laneErrors > 0 ? ` (${laneErrors} lane(s) failed to run)` : "") +
      (laneSummary ? ` [${laneSummary}]` : "");

    const raw = JSON.stringify(
      { verdict, failOn: threshold, counts, truncated, lanes: outcomes },
      null,
      2,
    );

    return {
      ok: true,
      summary,
      diagnostics: capped,
      summaryBlock:
        capped.length > 0 ? summarizeDiagnostics("quality-gate", capped) : undefined,
      raw: redactCredentials(raw),
    };
  },
};

/** Probe whether a lane's binary is available by invoking it via ctx.run. */
async function probeAvailable(
  ctx: ToolContext,
  request: Omit<ExecutionRequest, "cwd" | "timeoutMs" | "maxOutputBytes">,
): Promise<boolean> {
  try {
    const r = await ctx.run({ ...request, timeoutMs: 10_000 });
    return !(r.error?.code === "BinaryNotFound") && r.exitCode !== null;
  } catch {
    return false;
  }
}

const qualityGateStatus: ToolDefinition = {
  name: "quality_gate_status",
  description:
    "Report the detected project language and which quality/security lanes are available (Ruff/Biome, Semgrep, Trivy binary availability) — read-only; use before running quality_gate.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "workspace-relative directory to inspect (default: workspace root)",
      },
    },
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path } = validated.value as { path?: string };
    let gateAbs: string;
    if (path !== undefined) {
      if (!isValidPathInput(path)) {
        return invalid("path must be a non-empty workspace path");
      }
      try {
        gateAbs = resolveInWorkspace(ctx.workspaceRoot, path);
      } catch (err) {
        if (err instanceof WorkspaceViolationError) {
          return {
            ok: false,
            summary: "path escapes the workspace boundary",
            error: { code: "WorkspaceViolation", message: `rejected: ${path}` },
          };
        }
        return toolFailure(`path could not be resolved: ${String(err)}`);
      }
    } else {
      gateAbs = resolveInWorkspace(ctx.workspaceRoot, ".");
    }

    const language = detectLanguage(gateAbs);
    // Probe each lane binary through ctx.run (the core runner), never a bare
    // PATH name, so a missing binary is a real detection, not a cwd search.
    const probes: Array<{ name: string; request: Omit<ExecutionRequest, "cwd" | "timeoutMs" | "maxOutputBytes"> }> = [];
    if (language === "python") {
      probes.push({ name: "ruff_check", request: { binary: resolveRuffBinary(), args: ["--version"] } });
    }
    if (language === "web") {
      const biome = resolveBiomeBinary();
      probes.push({ name: "biome_check", request: { binary: biome.binary, args: [...biome.prefixArgs, "--version"] } });
    }
    probes.push({ name: "trivy_secret_scan", request: { binary: resolveTrivyBinary(), args: ["--version"] } });
    probes.push({ name: "semgrep_security_scan", request: { binary: resolveSemgrepBinary(), args: ["--version"] } });

    const lanes = await Promise.all(
      probes.map(async (p) => ({
        name: p.name,
        available: await probeAvailable(ctx, p.request),
      })),
    );
    const available = lanes.filter((l) => l.available).length;
    if (available === 0) {
      return binaryNotFound(
        "no quality tools available (Ruff/Biome, Semgrep, Trivy not installed)",
      );
    }
    const raw = JSON.stringify(
      { language, lanes, total: lanes.length, available },
      null,
      2,
    );
    return {
      ok: true,
      summary: `quality gate status: ${language} project, ${available}/${lanes.length} lanes available`,
      raw: redactCredentials(raw),
    };
  },
};

export const qualityGatePlugin: {
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
    name: "@dsh-forge/plugin-quality-gate",
    version: "0.1.0",
    upstreamTool: "quality-gate (orchestration of Ruff/Biome/Semgrep/Trivy)",
    coreContractVersion: "0.1.0",
    capabilities: [
      "quality-gate",
      "lint:python",
      "lint:web",
      "security:secrets",
      "security:audit",
    ],
  },
  tools: [qualityGate, qualityGateStatus],
};
