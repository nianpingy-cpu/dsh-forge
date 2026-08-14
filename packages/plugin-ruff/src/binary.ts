/**
 * Binary resolution for Ruff (ISSUE-011).
 *
 * Ruff ships as a standalone binary (pip/uv/brew/homebrew), not an npm
 * package, so resolution is PATH-based. Missing binary is a BinaryNotFound
 * tool error — never a silent fallback.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** Resolve the ruff binary from PATH, falling back to a bare name. */
export function resolveRuffBinary(): string {
  const candidates = IS_WINDOWS ? ["ruff.exe", "ruff"] : ["ruff"];
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        const full = join(dir, candidate);
        // A regular file (not a directory) is an executable candidate; spawn
        // reports BinaryNotFound if it turns out not to be runnable.
        if (statSync(full).isFile()) return full;
      } catch {
        // continue searching
      }
    }
  }
  // Last resort: bare name — spawn reports BinaryNotFound if absent.
  return "ruff";
}

export const RUFF_BINARY_HINT =
  "install Ruff: pip install ruff (or see https://docs.astral.sh/ruff/installation/)";
