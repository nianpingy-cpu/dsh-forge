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
import { fileURLToPath } from "node:url";

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
  for (const field of COMPARED_FIELDS) {
    const a = pinned[field];
    const b = latest[field];
    if (JSON.stringify(a ?? undefined) !== JSON.stringify(b ?? undefined)) {
      drifts.push({ field, pinned: a ?? null, latest: b ?? null });
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main();
}
