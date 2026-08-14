/**
 * Upstream compatibility lock validator (ISSUE-002).
 *
 * DeepSeek Harness is in developer preview and iterates rapidly. All plugin
 * work must target the commit pinned in compatibility/deepseek-harness.json.
 * This validator enforces that the manifest exists and is well-formed before
 * any integration code is touched.
 */

import { readFileSync } from "node:fs";

export interface CompatibilityManifest {
  repository: string;
  commit: string;
  branch: string;
  checked_at: string;
  node_requirement: string;
  package_manager: string;
  tool_registration_api: string;
  permission_hook_api: string;
  notes: string[];
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

const REQUIRED_STRING_FIELDS = [
  "repository",
  "commit",
  "branch",
  "checked_at",
  "node_requirement",
  "package_manager",
  "tool_registration_api",
  "permission_hook_api",
] as const;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, errors: ["manifest must be a JSON object"] };
  }

  const manifest = input as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = manifest[field];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(
        `missing or empty required field: ${field} (must be a non-empty string)`,
      );
    }
  }

  if (
    typeof manifest.commit === "string" &&
    manifest.commit.trim() !== "" &&
    !COMMIT_SHA_PATTERN.test(manifest.commit)
  ) {
    errors.push(
      "commit must be a full 40-character hexadecimal git SHA (short SHAs are not allowed)",
    );
  }

  if (
    typeof manifest.checked_at === "string" &&
    manifest.checked_at.trim() !== "" &&
    !ISO_DATE_PATTERN.test(manifest.checked_at)
  ) {
    errors.push("checked_at must be an ISO date string (YYYY-MM-DD)");
  }

  if (!Array.isArray(manifest.notes)) {
    errors.push("notes must be an array of strings");
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Read a manifest from disk and validate it. A missing file or malformed JSON
 * is returned as a graceful ValidationResult (never a thrown ENOENT), so the
 * "missing manifest fails" TDD case is exercised as a real failure path.
 */
export function readManifest(manifestPath: string): ValidationResult {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      valid: false,
      errors: [`manifest not found at ${manifestPath} (${code ?? "read error"})`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [`manifest is not valid JSON: ${String(err)}`],
    };
  }
  return validateManifest(parsed);
}

export function formatResult(
  manifestPath: string,
  result: ValidationResult,
): string {
  if (result.valid) {
    return `OK: ${manifestPath} is a valid compatibility manifest`;
  }
  return `INVALID: ${manifestPath}\n  - ${result.errors.join("\n  - ")}`;
}
