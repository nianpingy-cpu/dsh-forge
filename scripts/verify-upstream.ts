/**
 * Upstream compatibility lock validator (ISSUE-002).
 *
 * DeepSeek Harness is in developer preview and iterates rapidly. All plugin
 * work must target the commit pinned in compatibility/deepseek-harness.json.
 * This validator enforces that the manifest exists and is well-formed before
 * any integration code is touched.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

export interface ReachabilityResult {
  reachable: boolean;
  detail: string;
}

/**
 * Re-verify the pinned SHA at execution time: `git ls-remote` against the
 * recorded upstream repository/branch (fixed arguments, no shell, consistent
 * with ADR-004). A fabricated 40-hex SHA is rejected because it is not
 * reachable. The exec is injectable for tests.
 */
export function checkReachability(
  repository: string,
  branch: string,
  commit: string,
  exec: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    }),
): ReachabilityResult {
  try {
    const out = exec("git", [
      "ls-remote",
      `https://github.com/${repository}.git`,
      branch,
    ]);
    if (out.includes(commit)) {
      return {
        reachable: true,
        detail: `pinned commit ${commit} is reachable on ${repository}@${branch}`,
      };
    }
    return {
      reachable: false,
      detail: `pinned commit ${commit} was NOT found on ${repository}@${branch} (git ls-remote)`,
    };
  } catch (err) {
    return {
      reachable: false,
      detail: `git ls-remote failed for ${repository}: ${String(err)}`,
    };
  }
}

/**
 * Runnable entry point. Validates the manifest locally and re-verifies the
 * pinned SHA against the upstream repository; prints the pinned SHA and exits
 * 0 when valid+reachable, 1 otherwise. CI: `node scripts/verify-upstream.ts`.
 */
export function main(
  manifestPath = "compatibility/deepseek-harness.json",
  options: { exec?: (cmd: string, args: string[]) => string } = {},
): number {
  const result = readManifest(manifestPath);
  if (!result.valid) {
    console.error(formatResult(manifestPath, result));
    return 1;
  }
  let commit = "(unknown)";
  let branch = "";
  let repository = "";
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      commit?: string;
      branch?: string;
      repository?: string;
    };
    commit = raw.commit ?? "(missing)";
    branch = raw.branch ?? "";
    repository = raw.repository ?? "";
  } catch {
    // readManifest already validated; keep fallback values
  }
  console.log("OK: compatibility manifest is valid");
  console.log(`Pinned DeepSeek Harness commit: ${commit} (${branch})`);
  const reachability = checkReachability(repository, branch, commit, options.exec);
  if (!reachability.reachable) {
    console.error(`REJECTED: ${reachability.detail}`);
    return 1;
  }
  console.log(reachability.detail);
  return 0;
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv[2] ?? "compatibility/deepseek-harness.json");
}
