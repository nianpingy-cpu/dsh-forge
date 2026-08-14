/**
 * Binary resolution for act (ISSUE-015).
 *
 * act ships as a standalone Go binary (GitHub releases), not an npm package,
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** Resolve the act binary from PATH, falling back to a bare name. */
export function resolveActBinary(): string {
  const candidates = IS_WINDOWS ? ["act.exe", "act"] : ["act"];
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        const full = join(dir, candidate);
        if (statSync(full).isFile()) return full;
      } catch {
        // continue searching
      }
    }
  }
  // Last resort: bare name — spawn reports BinaryNotFound if absent.
  return "act";
}

export const ACT_BINARY_HINT =
  "install act: download the binary from https://github.com/nektos/act/releases (see https://nektosact.com for instructions)";
