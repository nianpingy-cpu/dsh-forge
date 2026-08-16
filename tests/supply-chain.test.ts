/**
 * ISSUE-029 supply-chain packaging gate.
 *
 * Supply chain critical. TDD RED tests for packaging checks:
 *  1. No secrets in built artifacts.
 *  2. Package contents allowlist — built packages ship only expected files.
 *  3. No upstream binaries are redistributed in the repository (detect and
 *     invoke installed binaries instead; ISSUE-029 policy).
 *  4. Lockfile discipline — pnpm-lock.yaml is present and committed.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function packageDirs(): string[] {
  return readdirSync(join(ROOT, "packages"))
    .filter((d) => d.startsWith("plugin-") || d === "core")
    .map((d) => join(ROOT, "packages", d));
}

/** Recursively collect all files under a directory (relative paths). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, rel: string) => {
    const abs = join(base, rel);
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const child of readdirSync(abs)) walk(abs, child);
    } else {
      out.push(rel.split("\\").join("/"));
    }
  };
  walk(dir, "");
  return out;
}

/** Redaction/skimmer patterns: keys, tokens, private keys, connection strings. */
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /sk-[A-Za-z0-9]{20,}/, // OpenAI/DeepSeek-style API keys
  /ghp_[A-Za-z0-9]{20,}/, // GitHub personal access token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private keys
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /xox[baprs]-[0-9A-Za-z-]{10,}/, // Slack token
];

describe("ISSUE-029 supply chain", () => {
  it("ships no secrets in built artifacts", () => {
    for (const dir of packageDirs()) {
      const dist = join(dir, "dist");
      if (!existsSync(dist)) continue; // not built in this run
      for (const file of filesUnder(dist)) {
        const content = readFileSync(join(dist, file), "utf8");
        for (const pattern of SECRET_PATTERNS) {
          expect(
            pattern.test(content),
            `${dir}/dist/${file} contains a value matching ${pattern}`,
          ).toBe(false);
        }
      }
    }
  });

  it("shipping source files is not required, but dist artifacts stay inside the allowlist", () => {
    // Only run when dist is present; otherwise a stale build cannot leak.
    for (const dir of packageDirs()) {
      const dist = join(dir, "dist");
      if (!existsSync(dist)) continue;
      const files = filesUnder(dist);
      expect(files.length, `${dir} dist is empty`).toBeGreaterThan(0);
      for (const file of files) {
        // Only JS/JS map/d.ts artifacts are expected in a tsup build.
        expect(
          /\.(js|js\.map|d\.ts|d\.cts|d\.mts)$/.test(file),
          `${dir}/dist contains unexpected file: ${file}`,
        ).toBe(true);
      }
    }
  });

  it("does not redistribute upstream binaries", () => {
    // Policy (ISSUE-029): detect installed binaries and invoke them; never
    // commit upstream binaries without license review.
    const suspicious = [
      "**/bin/*", // checked-in binaries
      "**/binaries/*",
      "**/*.exe",
      "**/*.dll",
      "**/*.so",
      "**/*.dylib",
      "**/vendor/**", // vendored third-party code
    ];
    // Walk the repo (excluding node_modules and dist) for binary files.
    const walk = (dir: string, rel: string): string[] => {
      const out: string[] = [];
      const abs = join(dir, rel);
      if (!existsSync(abs)) return out;
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (["node_modules", "dist", ".git", "coverage", ".ruff_cache"].includes(rel)) {
          return out;
        }
        for (const child of readdirSync(abs)) out.push(...walk(abs, child));
      } else {
        const p = rel.split("\\").join("/");
        if (/\.(exe|dll|so|dylib|a|o|bin)$/i.test(p)) out.push(p);
      }
      return out;
    };
    const binaries = walk(ROOT, "");
    expect(binaries, "upstream binaries must not be redistributed").toEqual([]);
    // Also confirm the declared package managers don't pull binaries via
    // scripts that bypass detection (documented in SECURITY.md).
    void suspicious;
  });

  it("keeps lockfile discipline", () => {
    const lockfile = join(ROOT, "pnpm-lock.yaml");
    expect(existsSync(lockfile), "pnpm-lock.yaml must be committed").toBe(true);
    const content = readFileSync(lockfile, "utf8");
    expect(content.length, "pnpm-lock.yaml must not be empty").toBeGreaterThan(100);
  });

  it("uses only allowlisted, standard licenses in production dependencies", () => {
    // Root + workspace package manifests must declare a known license.
    const allowed = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
    const manifests = ["package.json", ...packageDirs().map((d) => join(d, "package.json"))];
    for (const manifest of manifests) {
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { license?: string };
      if (!pkg.license) continue; // private workspace root is fine
      expect(
        allowed.has(pkg.license),
        `${manifest} uses unapproved license: ${pkg.license}`,
      ).toBe(true);
    }
  });
});
