/**
 * ISSUE-028 documentation gate.
 *
 * Docs issue — validation via a doc-link checker test:
 *  1. Every plugin package and `@dsh-forge/core` ships a README.md.
 *  2. Relative markdown links in those READMEs resolve to real files.
 *  3. Every documented example directory exists and has a runnable README.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** All packages that must ship a README (plugin packages + core). */
function packageDirs(): string[] {
  return readdirSync(join(ROOT, "packages"))
    .filter((d) => d.startsWith("plugin-") || d === "core")
    .map((d) => join(ROOT, "packages", d));
}

/** Extract `[text](target)` markdown link targets from a README. */
function markdownLinks(readme: string): string[] {
  const links: string[] = [];
  // Matches [text](target) where target is not a URL, anchor, or mailto.
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(readme)) !== null) {
    const target = m[1].trim();
    if (
      /^(https?:|mailto:|#)/.test(target) ||
      target.startsWith("http") ||
      target.includes("://")
    ) {
      continue;
    }
    // Strip optional title suffix `"..."` if present.
    const pathPart = target.split(/\s+"[^"]*"$/)[0].trim();
    links.push(pathPart);
  }
  return links;
}

describe("ISSUE-028 documentation", () => {
  it("ships a README.md for every plugin package and core", () => {
    const dirs = packageDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(11);
    for (const dir of dirs) {
      expect(
        existsSync(join(dir, "README.md")),
        `${dir} is missing README.md`,
      ).toBe(true);
    }
  });

  it("resolves every relative markdown link inside package READMEs", () => {
    for (const dir of packageDirs()) {
      const readmePath = join(dir, "README.md");
      if (!existsSync(readmePath)) continue; // reported by the previous test
      const readme = readFileSync(readmePath, "utf8");
      for (const target of markdownLinks(readme)) {
        if (target.includes(" ")) continue; // not a bare file path
        const abs = resolve(dirname(readmePath), target);
        expect(
          existsSync(abs),
          `${readmePath} links to missing target: ${target}`,
        ).toBe(true);
      }
    }
  });

  it("documents the six example scenarios with a runnable README", () => {
    const examples = [
      "python-quality",
      "web-quality",
      "security-scan",
      "local-ci",
      "load-test",
      "media",
    ];
    const examplesRoot = join(ROOT, "examples");
    expect(existsSync(examplesRoot), "examples/ directory missing").toBe(true);
    for (const name of examples) {
      const dir = join(examplesRoot, name);
      expect(existsSync(dir), `examples/${name} directory missing`).toBe(true);
      expect(
        existsSync(join(dir, "README.md")),
        `examples/${name}/README.md missing`,
      ).toBe(true);
    }
  });

  it("documents the seven presets in the presets package README", () => {
    const readmePath = join(ROOT, "packages", "presets", "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    for (const preset of [
      "coding",
      "python",
      "web",
      "security",
      "devops",
      "media",
      "full",
    ]) {
      expect(
        readme.includes(preset),
        `presets README does not document preset "${preset}"`,
      ).toBe(true);
    }
  });
});
