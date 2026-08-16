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
});
