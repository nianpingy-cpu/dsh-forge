/**
 * Binary resolution for Biome (ISSUE-012).
 *
 * Biome ships as the @biomejs/biome npm package; its `bin/biome` is a Node
 * shim that dispatches to the platform-specific native binary. The shim is
 * spawned via the current Node executable (typed argv, no shell). Falls back
 * to a bare `biome` on PATH. Missing binary is a BinaryNotFound tool error —
 * never a silent fallback.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface BiomeBinary {
  /** The executable to spawn (node for the shim, or a PATH binary). */
  binary: string;
  /** Arguments prepended to the tool args (the shim path when using node). */
  prefixArgs: string[];
}

/** Resolve the biome invocation: npm shim first, then PATH fallback. */
export function resolveBiomeBinary(): BiomeBinary {
  try {
    const pkgJsonPath = require.resolve("@biomejs/biome/package.json");
    const shim = join(dirname(pkgJsonPath), "bin", "biome");
    if (existsSync(shim)) {
      return { binary: process.execPath, prefixArgs: [shim] };
    }
  } catch {
    // package not installed — fall through to PATH
  }
  return { binary: "biome", prefixArgs: [] };
}

export const BIOME_BINARY_HINT =
  "install Biome: npm install -D @biomejs/biome (or see https://biomejs.dev/guides/installation/)";
