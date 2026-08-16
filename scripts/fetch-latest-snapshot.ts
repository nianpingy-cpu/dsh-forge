/**
 * Build the Latest-lane upstream snapshot (ISSUE-027).
 *
 * Fetches REAL machine-observable values from the upstream repository at
 * master via the GitHub API (invoked through the gh CLI, which the workflow
 * authenticates):
 * - the master commit SHA
 * - engines.node  -> node_requirement
 * - packageManager -> package_manager
 *
 * Fields that are not machine-observable (the descriptive
 * tool_registration_api / permission_hook_api notes, verified by a human at
 * pin time) are deliberately omitted so buildReport() excludes them from the
 * comparison (reported as unobservedFields) instead of mirroring the pinned
 * values and passing them off as upstream observations.
 *
 * Usage: node scripts/fetch-latest-snapshot.ts <owner/repo> <out.json>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function ghApi(jq: string, ...path: string[]): string {
  return execFileSync(
    "gh",
    ["api", ...path, "--jq", jq],
    { encoding: "utf8" },
  ).trim();
}

function main(): void {
  const [, , repo, outPath] = process.argv;
  if (!repo || !outPath) {
    console.error("usage: node scripts/fetch-latest-snapshot.ts <owner/repo> <out.json>");
    process.exit(2);
  }
  const commit = ghApi(".sha", `repos/${repo}/commits/master`);
  let nodeRequirement: string | undefined;
  let packageManager: string | undefined;
  try {
    const b64 = ghApi(".content", `repos/${repo}/contents/package.json?ref=master`);
    const pkg = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      engines?: { node?: string };
      packageManager?: string;
    };
    if (pkg.engines?.node) nodeRequirement = pkg.engines.node;
    if (pkg.packageManager) packageManager = pkg.packageManager;
  } catch (err) {
    // package.json unreadable at master — leave the fields unobserved rather
    // than fabricating values.
    console.error(`warning: could not read package.json at master: ${String(err)}`);
  }

  const snapshot = {
    repository: repo,
    commit,
    branch: "master",
    checked_at: new Date().toISOString().slice(0, 10),
    ...(nodeRequirement !== undefined ? { node_requirement: nodeRequirement } : {}),
    ...(packageManager !== undefined ? { package_manager: packageManager } : {}),
  };
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`latest snapshot written: ${outPath} (commit ${commit})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
