import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../scripts/verify-upstream";

const validManifest = {
  repository: "deepseek-ai/deepseek-harness",
  commit: "47f943859bef60e4160492346772ded9b24f765a",
  branch: "master",
  checked_at: "2026-08-14",
  node_requirement: ">=22.19 (CI: 22.19, 24, 26)",
  package_manager: "pnpm@11.7.0 via corepack",
  tool_registration_api: "cordis plugin ctx (Host aggregate)",
  permission_hook_api: "TBD — verify at pinned SHA",
  notes: [],
};

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
  });

  it("rejects a non-object manifest", () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an invalid commit SHA", () => {
    const result = validateManifest({
      ...validManifest,
      commit: "not-a-sha",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join("\n")).toMatch(/commit/);
  });

  it("rejects a short commit SHA", () => {
    const result = validateManifest({
      ...validManifest,
      commit: "47f9438",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a missing required field", () => {
    const result = validateManifest({
      ...validManifest,
      branch: undefined,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join("\n")).toMatch(/branch/);
  });

  it("rejects an empty required field", () => {
    const result = validateManifest({
      ...validManifest,
      repository: "",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join("\n")).toMatch(/repository/);
  });

  it("rejects an invalid checked_at date", () => {
    const result = validateManifest({
      ...validManifest,
      checked_at: "yesterday",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join("\n")).toMatch(/checked_at/);
  });

  it("rejects notes that is not an array", () => {
    const result = validateManifest({
      ...validManifest,
      notes: "some note",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join("\n")).toMatch(/notes/);
  });

  it("accepts the real repository manifest", () => {
    const manifestPath = fileURLToPath(
      new URL("../compatibility/deepseek-harness.json", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });
});
