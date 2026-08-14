/**
 * Binary resolution for uv (ISSUE-014).
 *
 * uv ships as a standalone binary (pip/curl/powershell), not an npm package,
 * so resolution is PATH-based. Missing binary is a BinaryNotFound tool error
 * — never a silent fallback.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** Resolve the uv binary from PATH, falling back to a bare name. */
export function resolveUvBinary(): string {
  const candidates = IS_WINDOWS ? ["uv.exe", "uv"] : ["uv"];
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
  return "uv";
}

export const UV_BINARY_HINT =
  "install uv: pip install uv (or see https://docs.astral.sh/uv/getting-started/installation/)";
