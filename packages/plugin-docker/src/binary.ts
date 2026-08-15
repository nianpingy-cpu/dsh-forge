/**
 * Binary resolution for docker (ISSUE-020).
 *
 * docker ships as a platform binary (or the Docker Desktop CLI), not an npm
 * package, so resolution is PATH-based. Missing binary is a BinaryNotFound
 * tool error — never a silent fallback.
 *
 * Resolution invariants (from external security review of the act plugin):
 *  1. NEVER return a bare name — on Windows, CreateProcess resolves a bare
 *     name by searching the parent process's cwd (often the workspace being
 *     analyzed) before PATH, so a repo-planted docker.exe could run with no
 *     permission prompt. Every resolved binary is an absolute path.
 *  2. When absent, return a RANDOM, non-existent absolute path (never a
 *     predictable path in a world-writable dir like /tmp). Spawning it yields
 *     ENOENT, which the core runner maps to BinaryNotFound.
 *  3. Relative PATH entries are skipped.
 */
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const IS_WINDOWS = process.platform === "win32";

function resolveInPath(name: string): string | undefined {
  const candidates = IS_WINDOWS ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    // Skip relative entries: join('.', 'docker') === 'docker' — a bare name
    // would let Windows CreateProcess search the harness cwd (the analyzed
    // workspace) before PATH.
    if (!isAbsolute(dir)) continue;
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

/** Resolve the docker binary from PATH; never falls back to a bare name. */
export function resolveDockerBinary(): string {
  return (
    resolveInPath("docker") ??
    missingSentinel(IS_WINDOWS ? "docker.exe" : "docker")
  );
}

export const DOCKER_BINARY_HINT =
  "install Docker (Docker Desktop or the docker CLI): see https://docs.docker.com/engine/install/";
