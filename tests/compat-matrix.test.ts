import { describe, expect, it } from "vitest";
import { buildReport, type UpstreamSnapshot } from "../scripts/compat-matrix.js";

const pinned: UpstreamSnapshot = {
  repository: "deepseek-ai/deepseek-harness",
  commit: "AAAA1111",
  branch: "master",
  node_requirement: ">=22.19",
  package_manager: "pnpm@11.7.0",
  tool_registration_api: "Cordis plugin architecture",
  permission_hook_api: "TBD",
};

describe("compat matrix report generation (ISSUE-027)", () => {
  it("reports compatible when the latest upstream matches the pinned snapshot", () => {
    const report = buildReport(pinned, { ...pinned });
    expect(report.status).toBe("compatible");
    expect(report.drifts).toEqual([]);
    expect(report.blocking).toBe(false);
    expect(report.latestCommit).toBe(pinned.commit);
  });

  it("reports drift on a simulated upstream break (new commit + changed requirements)", () => {
    // A simulated upstream break: master advanced and the platform
    // requirements changed. This is a Latest-lane finding -> non-blocking.
    const latest: UpstreamSnapshot = {
      ...pinned,
      commit: "BBBB2222",
      node_requirement: ">=24",
      package_manager: "pnpm@12.0.0",
      permission_hook_api: "verified: permission hook now exposed",
    };
    const report = buildReport(pinned, latest);
    expect(report.status).toBe("drift");
    expect(report.blocking).toBe(false); // Latest lane is report-only
    expect(report.drifts.map((d) => d.field).sort()).toEqual([
      "commit",
      "node_requirement",
      "package_manager",
      "permission_hook_api",
    ]);
    expect(report.latestCommit).toBe("BBBB2222");
  });

  it("flags a release blocker when the pinned manifest is invalid (Pinned lane)", () => {
    // The Pinned lane is the release blocker: a missing/empty pinned commit
    // must block the release.
    const brokenPinned: UpstreamSnapshot = { ...pinned, commit: "" };
    const report = buildReport(brokenPinned, { ...pinned });
    expect(report.blocking).toBe(true);
    expect(report.pinnedValid).toBe(false);
  });
});
