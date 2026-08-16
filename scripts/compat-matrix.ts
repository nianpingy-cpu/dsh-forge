/**
 * DeepSeek Harness compatibility matrix (ISSUE-027).
 *
 * Two CI lanes:
 * - **Pinned** (required, release blocker): integration targets the commit
 *   pinned in `compatibility/deepseek-harness.json`; the pinned manifest
 *   must be valid (non-empty repository + commit) or the release is blocked.
 * - **Latest** (scheduled, non-blocking): compares the pinned snapshot against
 *   the current upstream master; drift produces a compatibility report
 *   artifact without blocking released plugins.
 *
 * This module generates the report shared by both lanes.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface UpstreamSnapshot {
  repository: string;
  commit: string;
  branch: string;
  node_requirement?: string;
  package_manager?: string;
  tool_registration_api?: string;
  permission_hook_api?: string;
}

export interface Drift {
  field: string;
  pinned: unknown;
  latest: unknown;
}

export interface CompatibilityReport {
  generatedAt: string;
  /** Pinned-lane integrity (release blocker). */
  pinnedValid: boolean;
  pinnedCommit: string;
  latestCommit: string;
  /** Latest-lane comparison: compatible | drift. */
  status: "compatible" | "drift";
  /** True when the Pinned lane is broken (release blocker); drift alone is not. */
  blocking: boolean;
  drifts: Drift[];
  /**
   * Fields the Latest lane could not observe from upstream (e.g. the
   * descriptive registration/permission-hook API notes, which are verified
   * by a human at pin time). They are excluded from the comparison instead
   * of being mirrored from the pinned manifest and passed off as upstream
   * observations.
   */
  unobservedFields: string[];
}

const COMPARED_FIELDS = [
  "commit",
  "node_requirement",
  "package_manager",
  "tool_registration_api",
  "permission_hook_api",
] as const;

/** Build the compatibility report for the two lanes. */
export function buildReport(
  pinned: UpstreamSnapshot,
  latest: UpstreamSnapshot,
): CompatibilityReport {
  const pinnedValid =
    typeof pinned.repository === "string" &&
    pinned.repository.trim() !== "" &&
    typeof pinned.commit === "string" &&
    pinned.commit.trim() !== "";

  const drifts: Drift[] = [];
  const unobservedFields: string[] = [];
  for (const field of COMPARED_FIELDS) {
    const a = pinned[field];
    const b = latest[field];
    if (b === undefined) {
      // The Latest lane did not observe this field from upstream (it is not
      // machine-fetchable). Exclude it from the comparison — never mirror
      // the pinned value and pretend upstream was compared.
      if (field !== "commit") unobservedFields.push(field);
      continue;
    }
    if (JSON.stringify(a ?? undefined) !== JSON.stringify(b)) {
      drifts.push({ field, pinned: a ?? null, latest: b });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    pinnedValid,
    pinnedCommit: pinned.commit,
    latestCommit: latest.commit,
    status: drifts.length === 0 ? "compatible" : "drift",
    blocking: !pinnedValid, // the Pinned lane is the release blocker
    drifts,
    unobservedFields,
  };
}

function readSnapshot(path: string): UpstreamSnapshot {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as UpstreamSnapshot;
}

/**
 * CLI: node scripts/compat-matrix.ts <pinned.json> <latest.json>
 * Writes the report to compatibility/reports/compat-<latestCommit>.json.
 */
function main(): void {
  const [, , pinnedPath, latestPath] = process.argv;
  if (!pinnedPath || !latestPath) {
    console.error("usage: node scripts/compat-matrix.ts <pinned.json> <latest.json>");
    process.exit(2);
  }
  const pinned = readSnapshot(pinnedPath);
  const latest = readSnapshot(latestPath);
  const report = buildReport(pinned, latest);
  const outDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "compatibility",
    "reports",
  );
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `compat-${report.latestCommit}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`report written: ${outFile}`);
  process.exit(report.blocking ? 1 : 0);
}

// pathToFileURL handles relative invocation paths (process.argv[1] may be
// "scripts/compat-matrix.ts") and Windows drive letters correctly — the same
// pattern as scripts/review-pr.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
