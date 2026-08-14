/**
 * Binary resolution for act (ISSUE-015).
 *
 * act ships as a standalone Go binary (GitHub releases), not an npm package,
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 *
 * Resolution invariants (from external security review):
 *  1. NEVER return a bare name — on Windows, CreateProcess resolves a bare
 *     name by searching the parent process's cwd (often the workspace being
 *     analyzed) before PATH, so a repo-planted act.exe/docker.exe could run
 *     with no permission prompt. Every resolved binary is an absolute path.
 *  2. When absent, return a RANDOM, non-existent absolute path (never a
 *     predictable path in a world-writable dir like /tmp, which a local
 *     attacker could pre-create). Spawning it yields ENOENT, which the core
 *     runner maps to BinaryNotFound.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const IS_WINDOWS = process.platform === "win32";

function resolveInPath(name: string): string | undefined {
  const candidates = IS_WINDOWS ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      try {
        const full = join(dir, candidate);
        if (statSync(full).isFile()) return full;
      } catch {
        // continue searching
      }
    }
  }
  return undefined;
}

/** Unpredictable absolute path that never exists (spawn -> ENOENT). */
function missingSentinel(name: string): string {
  return join(tmpdir(), `dsh-missing-${randomUUID()}`, name);
}

/** Resolve the act binary from PATH; never falls back to a bare name. */
export function resolveActBinary(): string {
  return (
    resolveInPath("act") ?? missingSentinel(IS_WINDOWS ? "act.exe" : "act")
  );
}

/** Resolve the docker binary from PATH; never falls back to a bare name. */
export function resolveDockerBinary(): string {
  return (
    resolveInPath("docker") ?? missingSentinel(IS_WINDOWS ? "docker.exe" : "docker")
  );
}

export const ACT_BINARY_HINT =
  "install act: download the binary from https://github.com/nektos/act/releases (see https://nektosact.com for instructions)";
