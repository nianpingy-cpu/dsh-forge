import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLockfileDeps } from "../scripts/supply-chain-check.js";

describe("real lockfile", () => {
  it("parses the committed pnpm-lock.yaml into a non-empty SBOM component list", () => {
    const lockfile = resolve(import.meta.dirname, "..", "pnpm-lock.yaml");
    const text = readFileSync(lockfile, "utf8");
    const deps = parseLockfileDeps(text);
    expect(deps.length).toBeGreaterThan(100);
    // No garbage identities.
    for (const d of deps) {
      expect(d.name.includes("(")).toBe(false);
      expect(d.version.includes(":")).toBe(false);
      expect(d.version.includes("{")).toBe(false);
      expect(d.version.includes("'")).toBe(false);
    }
    // Spot-check a few known deps.
    expect(deps).toContainEqual({ name: "@ampproject/remapping", version: "2.3.0" });
    expect(deps).toContainEqual({ name: "@bcoe/v8-coverage", version: "1.0.2" });
    expect(deps).toContainEqual({ name: "@eslint/js", version: "9.39.5" });
    expect(deps).toContainEqual({ name: "typescript", version: "5.9.3" });
  });
});
