/**
 * Binary resolution for k6 (ISSUE-022).
 *
 * k6 ships as a standalone Go binary (GitHub releases), not an npm package,
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 *
 * Resolution invariants (from external security review of the act plugin):
 *  1. NEVER return a bare name — on Windows, CreateProcess resolves a bare
 *     name by searching the parent process's cwd (often the workspace being
 *     analyzed) before PATH. Every resolved binary is an absolute path.
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

/** Resolve the k6 binary from PATH; never falls back to a bare name. */
export function resolveK6Binary(): string {
  return (
    resolveInPath("k6") ??
    missingSentinel(IS_WINDOWS ? "k6.exe" : "k6")
  );
}

export const K6_BINARY_HINT =
  "install k6: see https://grafana.com/docs/k6/latest/set-up/install-k6/ (download from https://github.com/grafana/k6/releases)";
