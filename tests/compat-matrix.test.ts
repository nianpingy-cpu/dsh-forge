import { describe, expect, it } from "vitest";
import { buildReport, type UpstreamSnapshot } from "../scripts/compat-matrix.js";

const pinned: UpstreamSnapshot = {
  repository: "deepseek-ai/deepseek-harness",
  commit: "AAAA1111",
  branch: "master",
  // Human-annotated values as stored in the real pinned manifest.
  node_requirement: ">=22.19 (upstream CI covers 22.19, 24, 26)",
  package_manager: "pnpm@11.7.0 via corepack (upstream pin)",
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
  it("does not drift on human annotations — only genuine upstream changes (normalized comparison)", () => {
    // The pinned manifest stores annotated values (">=22.19 (upstream CI
    // covers ...)"); the Latest lane fetches raw upstream values (">=22.19").
    // Verbatim comparison would drift on EVERY run; normalization extracts
    // the observable core so an unchanged upstream stays compatible.
    const latest: UpstreamSnapshot = {
      repository: pinned.repository,
      commit: pinned.commit,
      branch: "master",
      node_requirement: ">=22.19",
      package_manager: "pnpm@11.7.0",
    };
    const report = buildReport(pinned, latest);
    expect(report.status).toBe("compatible");
    expect(report.drifts.map((d) => d.field)).toEqual([]);
  });
  it("reports drift on a simulated upstream break (real observable fields)", () => {
    // A simulated upstream break as the Latest lane would observe it: master
    // advanced and the platform requirements changed. The descriptive API
    // notes are NOT machine-observable, so the snapshot omits them (they are
    // reported as unobserved, never mirrored from the pinned manifest).
    const latest: UpstreamSnapshot = {
      repository: pinned.repository,
      commit: "BBBB2222",
      branch: "master",
      node_requirement: ">=24",
      package_manager: "pnpm@12.0.0",
    };
    const report = buildReport(pinned, latest);
    expect(report.status).toBe("drift");
    expect(report.blocking).toBe(false); // Latest lane is report-only
    expect(report.drifts.map((d) => d.field).sort()).toEqual([
      "commit",
      "node_requirement",
      "package_manager",
    ]);
    expect(report.latestCommit).toBe("BBBB2222");
    // non-observable fields are excluded from the comparison and reported
    expect(report.unobservedFields.sort()).toEqual([
      "permission_hook_api",
      "tool_registration_api",
    ]);
  });

  it("never mirrors pinned values as upstream observations (unobserved fields excluded)", () => {
    // The Latest lane observed only the commit; every other compared field
    // is unobserved. The report must NOT claim the requirements matched —
    // they were simply not observable.
    const latest: UpstreamSnapshot = {
      repository: pinned.repository,
      commit: "CCCC3333",
      branch: "master",
    };
    const report = buildReport(pinned, latest);
    expect(report.drifts.map((d) => d.field)).toEqual(["commit"]);
    expect(report.unobservedFields.sort()).toEqual([
      "node_requirement",
      "package_manager",
      "permission_hook_api",
      "tool_registration_api",
    ]);
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
