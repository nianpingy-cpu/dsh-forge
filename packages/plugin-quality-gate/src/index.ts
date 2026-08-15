/**
 * Quality / security gate (ISSUE-018) — orchestration only, no
 * reimplementation. The tool detects the project language, runs the matching
 * lint lane (Ruff for Python, Biome for JS/TS) plus the security lanes
 * (Semgrep audit, Trivy secrets) by composing the existing plugin tools,
 * aggregates their normalized diagnostics, and returns a
 * PASS / PASS_WITH_WARNINGS / FAIL verdict with configurable thresholds.
 *
 * Lane policy:
 * - A lane whose binary is not installed (BinaryNotFound) is recorded as
 *   "skipped" and does not fail the gate (other lanes still gate).
 * - A lane that errors for any other reason fails the gate (FAIL) — the gate
 *   cannot certify quality when a lane did not run.
 * - If no lane actually ran, the gate returns a ToolFailure instead of
 *   fabricating a verdict.
 */
import {
  validateArgs,
  resolveInWorkspace,
  WorkspaceViolationError,
  summarizeDiagnostics,
  type Diagnostic,
  type Severity,
  type ToolDefinition,
  type ToolResult,
} from "@dsh-forge/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ruffPlugin } from "@dsh-forge/plugin-ruff";
import { biomePlugin } from "@dsh-forge/plugin-biome";
import { semgrepPlugin } from "@dsh-forge/plugin-semgrep";
import { trivyPlugin } from "@dsh-forge/plugin-trivy";

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
  if (failOn === "error") {
    if (errors > 0) return { verdict: "FAIL", counts };
    if (warnings > 0) return { verdict: "PASS_WITH_WARNINGS", counts };
    return { verdict: "PASS", counts };
  }
  if (failOn === "warning") {
    if (errors + warnings > 0) return { verdict: "FAIL", counts };
    return { verdict: "PASS", counts };
  }
  // failOn === "any"
  if (diagnostics.length > 0) return { verdict: "FAIL", counts };
  return { verdict: "PASS", counts };
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
    "Detect the project (Python/JS/TS), run the matching lint lane (Ruff/Biome) plus security lanes (Semgrep audit, Trivy secrets) by composing the existing plugin tools, aggregate normalized diagnostics, and return a PASS / PASS_WITH_WARNINGS / FAIL verdict with configurable thresholds. Permission is enforced by each composed lane: read lanes (Ruff/Biome, Trivy secrets) always run; network lanes (Semgrep audit) require network approval and are skipped otherwise.",
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
      const result = await lane.tool.execute.call(lane.tool, lane.args, ctx);
      if (result.ok) {
        ran += 1;
        const ds = result.diagnostics ?? [];
        diagnostics.push(...ds);
        outcomes.push({ name: lane.name, status: "ok", findings: ds.length });
      } else if (
        result.error?.code === "BinaryNotFound" ||
        result.error?.code === "PermissionDenied"
      ) {
        // Binary not installed, or the lane's permission class was not
        // approved: skip the lane (reported in the breakdown) — the other
        // lanes still gate.
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
        "no quality tools available (Ruff/Biome, Semgrep, Trivy not installed or their permission classes not approved)",
      );
    }

    const capped = diagnostics.slice(0, cap);
    const truncated = diagnostics.length > cap;
    const { verdict, counts } = computeVerdict(capped, threshold, laneErrors);

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
  tools: [qualityGate],
};
