/**
 * ISSUE-029 supply-chain-check unit tests.
 *
 * Exercises the packaging-check functions in scripts/supply-chain-check.ts
 * (also pulls the script into the typecheck graph via tsconfig include).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanSecrets,
  checkContents,
  findRedistributedBinaries,
  parseLockfileDeps,
  uuidFromStamp,
  SECRET_PATTERNS,
} from "../scripts/supply-chain-check.js";

describe("supply-chain-check", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-check-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects secrets in built artifacts", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "const key = 'AKIAIOSFODNN7EXAMPLE';");
    const result = scanSecrets(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.file).toBe("index.js");
  });

  it("reports a clean artifact as ok", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "export const x = 1;");
    const result = scanSecrets(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("enforces the dist contents allowlist", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "ok");
    writeFileSync(join(dir, "dist", "config.json"), "{}");
    const result = checkContents(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("config.json"))).toBe(true);
  });

  it("accepts only tsup artifacts in dist", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "ok");
    writeFileSync(join(dir, "dist", "index.d.ts"), "export declare const x: number;");
    writeFileSync(join(dir, "dist", "index.js.map"), "{}");
    const result = checkContents(dir);
    expect(result.ok).toBe(true);
  });

  it("finds redistributed binaries in the tree", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tool.exe"), "MZ...");
    const found = findRedistributedBinaries(dir);
    expect(found.some((f) => f.endsWith("tool.exe"))).toBe(true);
  });

  it("does not flag normal source files as binaries", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};");
    writeFileSync(join(dir, "src", "notes.md"), "hello");
    const found = findRedistributedBinaries(dir);
    expect(found).toEqual([]);
  });

  it("includes a standard set of secret patterns", () => {
    const sources = SECRET_PATTERNS.map((p) => p.source);
    expect(sources.some((s) => s.includes("PRIVATE KEY"))).toBe(true);
    expect(sources.some((s) => s.startsWith("AKIA"))).toBe(true);
  });

  it("scans secrets inside nested dist subdirectories (regression: walker must keep relative paths)", () => {
    mkdirSync(join(dir, "dist", "chunks"), { recursive: true });
    writeFileSync(join(dir, "dist", "chunks", "vendor.js"), "const k='AKIAIOSFODNN7EXAMPLE';");
    const result = scanSecrets(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.file === "chunks/vendor.js")).toBe(true);
  });

  it("enforces the allowlist on nested dist files without crashing", () => {
    mkdirSync(join(dir, "dist", "chunks"), { recursive: true });
    writeFileSync(join(dir, "dist", "chunks", "vendor.js"), "ok");
    writeFileSync(join(dir, "dist", "chunks", "data.json"), "{}");
    const result = checkContents(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("chunks/data.json"))).toBe(true);
  });

  it("locates nested redistributed binaries by relative path", () => {
    mkdirSync(join(dir, "vendor", "bin"), { recursive: true });
    writeFileSync(join(dir, "vendor", "bin", "tool.exe"), "MZ");
    const found = findRedistributedBinaries(dir);
    expect(found).toContain("vendor/bin/tool.exe");
  });

  it("parses dependency entries from a pnpm lockfile packages section", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "packages:",
      "  '@eslint/js@9.30.0':",
      "    resolution: {integrity: sha512-abc}",
      "    engines: {node: '>=18'}:",
      "  typescript@5.8.0:",
      "    resolution: {integrity: sha512-def}",
      "  /@types/node@24.13.3:",
      "    resolution: {integrity: sha512-ghi}",
      "",
    ].join("\n");
    const deps = parseLockfileDeps(lockfile);
    expect(deps).toContainEqual({ name: "@eslint/js", version: "9.30.0" });
    expect(deps).toContainEqual({ name: "typescript", version: "5.8.0" });
    expect(deps).toContainEqual({ name: "@types/node", version: "24.13.3" });
  });

  it("strips peer-suffixes so SBOM components are real package identities", () => {
    const lockfile = [
      "packages:",
      "  '@eslint-community/eslint-utils@4.10.1(eslint@9.39.5)':",
      "    resolution: {integrity: sha512-peer}",
      "  'vite@6.0.11(rollup@4.40.0)':",
      "    resolution: {integrity: sha512-vite}",
      "",
    ].join("\n");
    const deps = parseLockfileDeps(lockfile);
    expect(deps).toContainEqual({
      name: "@eslint-community/eslint-utils",
      version: "4.10.1",
    });
    expect(deps).toContainEqual({ name: "vite", version: "6.0.11" });
    // No garbage components (name must not contain "(" or trailing peer part).
    for (const d of deps) {
      expect(d.name.includes("(")).toBe(false);
      expect(d.name.includes(")")).toBe(false);
    }
  });

  it("generates a valid RFC 4122 v4-shaped UUID for the SBOM serialNumber", () => {
    const uuid = uuidFromStamp("2026-08-16T04-25-45-545Z");
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)).toBe(true);
  });
});
