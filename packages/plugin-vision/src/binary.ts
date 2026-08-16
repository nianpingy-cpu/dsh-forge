/**
 * Worker resolution for @dsh-forge/plugin-vision (ISSUE-062).
 *
 * The plugin's deterministic engine is a committed ESM script
 * (`scripts/vision-worker.mjs`) executed via the current Node executable —
 * the same node-shim pattern as plugin-biome (typed argv, no shell).
 *
 * Resolution invariants (shared with the other plugins):
 *  1. NEVER return a bare name — on Windows, CreateProcess resolves a bare
 *     name by searching the parent process's cwd (often the workspace being
 *     analyzed) before PATH. The resolved worker is always an absolute path.
 *  2. When absent, return a RANDOM, non-existent absolute path (never a
 *     predictable path in a world-writable dir like /tmp). Spawning it yields
 *     ENOENT, which the core runner maps to BinaryNotFound.
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Absolute path to the committed worker script (never a bare name). */
export function resolveVisionWorker(): string {
  const here = fileURLToPath(
    new URL("../scripts/vision-worker.mjs", import.meta.url),
  );
  try {
    if (statSync(here).isFile()) return here;
  } catch {
    // fall through to the sentinel
  }
  // Unpredictable absolute path that never exists (spawn -> ENOENT).
  return join(tmpdir(), `dsh-missing-${randomUUID()}`, "vision-worker.mjs");
}

export const VISION_WORKER_HINT =
  "the vision worker script is missing from @dsh-forge/plugin-vision (reinstall the package)";
