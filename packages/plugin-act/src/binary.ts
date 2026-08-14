/**
 * Binary resolution for act (ISSUE-015).
 *
 * act ships as a standalone Go binary (GitHub releases), not an npm package,
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

const IS_WINDOWS = process.platform === "win32";

/**
 * Absolute sentinel path that never exists. Spawning it yields ENOENT, which
 * the core runner maps to BinaryNotFound. We must NOT return a bare name:
 * on Windows, CreateProcess resolves a bare name by searching the parent
 * process's cwd (often the workspace being analyzed) before PATH, so a repo
 * containing act.exe could be executed with no permission prompt.
 */
function missingSentinel(): string {
  return join(tmpdir(), "dsh-act-missing", IS_WINDOWS ? "act.exe" : "act");
}

/** Resolve the act binary from PATH; never falls back to a bare name. */
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
  return missingSentinel();
}

export const ACT_BINARY_HINT =
  "install act: download the binary from https://github.com/nektos/act/releases (see https://nektosact.com for instructions)";
