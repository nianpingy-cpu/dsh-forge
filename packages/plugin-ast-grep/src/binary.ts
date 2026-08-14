/**
 * Binary resolution for ast-grep (ISSUE-009).
 *
 * Strategy: resolve the @ast-grep/cli npm package binary first (pinned,
 * cross-platform), then fall back to PATH lookup. Missing binary is a
 * BinaryNotFound tool error — never a silent fallback to grep.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const IS_WINDOWS = process.platform === "win32";

function sgBinaryName(): string {
  return IS_WINDOWS ? "sg.exe" : "sg";
}

/** Resolve the sg binary: npm package first, then PATH candidates. */
export function resolveSgBinary(): string | undefined {
  // 1. npm package binary (@ast-grep/cli ships sg/ast-grep executables)
  try {
    const pkgJsonPath = require.resolve("@ast-grep/cli/package.json");
    const candidate = join(dirname(pkgJsonPath), sgBinaryName());
    if (existsSync(candidate)) return candidate;
    const alt = join(dirname(pkgJsonPath), "ast-grep" + (IS_WINDOWS ? ".exe" : ""));
    if (existsSync(alt)) return alt;
  } catch {
    // package not installed — fall through to PATH
  }

  // 2. PATH-style candidates (spawn resolves bare names via PATH on both
  // platforms when given a non-path binary name)
  const candidates = IS_WINDOWS
    ? ["sg.exe", "ast-grep.exe", "sg", "ast-grep"]
    : ["sg", "ast-grep"];
  for (const candidate of candidates) {
    try {
      const which = require.resolve(candidate);
      if (existsSync(which)) return which;
    } catch {
      // continue
    }
  }

  // 3. Last resort: bare name — spawn will fail with BinaryNotFound if absent
  return "sg";
}

export const SG_BINARY_HINT =
  "install ast-grep: npm install -D @ast-grep/cli (or https://ast-grep.github.io/installation/)";

export { fileURLToPath };
