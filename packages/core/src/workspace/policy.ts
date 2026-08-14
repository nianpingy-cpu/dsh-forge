/**
 * Workspace boundary and permission policy (ISSUE-006, ADR-005).
 *
 * Any write operation must resolve inside the workspace root. Traversal
 * (`..`), absolute-path escape, and symlink escape are rejected by default.
 * Side-effecting mutation classes require explicit approval; destructive
 * operations additionally require the destructive guard.
 */
import { realpathSync, lstatSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type MutationClass =
  | "read"
  | "workspace-write"
  | "network"
  | "process"
  | "system-change"
  | "destructive";

export class WorkspaceViolationError extends Error {
  constructor(target: string) {
    super(`path escapes the workspace boundary: ${target}`);
    this.name = "WorkspaceViolationError";
  }
}

export class DestructiveOperationError extends Error {
  constructor() {
    super(
      "destructive operation blocked: requires explicit destructiveAllowed approval",
    );
    this.name = "DestructiveOperationError";
  }
}

/**
 * Resolve a target path inside the workspace root, rejecting escapes.
 * Symlinks are resolved to their real paths before the boundary check, and
 * the *canonicalized* location is returned (not the raw input path) so a
 * symlink swap between validation and use cannot escape the workspace.
 */
export function resolveInWorkspace(root: string, target: string): string {
  const workspaceRoot = realpathSync(root);
  // Backslash separators are a Windows path convention; normalize them only
  // there. On POSIX a backslash is a legitimate filename character and must
  // not be rewritten.
  const normalizedTarget =
    process.platform === "win32" ? target.replace(/\\/g, "/") : target;
  const candidate = isAbsolute(normalizedTarget)
    ? resolve(normalizedTarget)
    : resolve(workspaceRoot, normalizedTarget);

  // Fully canonicalize the deepest existing ancestor, then re-append any
  // non-existent tail. Both sides are canonical and compared with their
  // on-disk casing (realpathSync preserves it) — a case-insensitive
  // comparison would let differently-cased siblings count as "inside" on
  // case-sensitive filesystems.
  const canonical = canonicalize(candidate);
  const rootCanonical = canonicalize(workspaceRoot);

  const contained =
    canonical === rootCanonical || canonical.startsWith(rootCanonical + sep);
  if (!contained) {
    throw new WorkspaceViolationError(target);
  }
  return canonical;
}

/**
 * Canonicalize a path: realpath the deepest existing ancestor and re-append
 * any non-existent tail (preserving the requested tail, e.g. "a.ts").
 *
 * Error handling rules (do NOT conflate denials with non-existence):
 * - Walk up to an ancestor ONLY on ENOENT (the path truly does not exist).
 * - Rethrow EACCES/EPERM (access denied), ELOOP (symlink loop) and other
 *   hard errors instead of judging the boundary on an ancestor.
 * - A dangling symlink (lstat succeeds but realpath cannot follow it) is an
 *   error, not a non-existent path.
 */
function canonicalize(path: string): string {
  const original = resolve(path);
  let current = original;
  for (;;) {
    try {
      const real = realpathSync(current);
      const tail = original.slice(current.length);
      return tail ? real + tail : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Access denied, symlink loop, or any non-"missing" failure.
        throw error;
      }
      // A real directory entry that cannot be followed (this includes the
      // leaf itself: a target that IS a dangling symlink) is not a plain
      // "does not exist". Reject rather than walk up and resurrect the
      // symlink path as "canonical", which a later write would follow
      // outside the workspace.
      if (isDanglingSymlink(current)) {
        throw error;
      }
      const parent = resolve(current, "..");
      if (parent === current) return original; // reached filesystem root
      current = parent;
    }
  }
}

/** True when `path` exists as a symbolic link (possibly dangling). */
function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export type OperationDescriptor =
  | { kind: "read" }
  | { kind: "write"; target: string }
  | { kind: "fetch"; url: string }
  | { kind: "spawn"; command: string }
  | { kind: "system"; target: string }
  | { kind: "delete"; irreversible: boolean };

/** Classify an operation descriptor into its MutationClass. */
export function classifyMutation(operation: OperationDescriptor): MutationClass {
  switch (operation.kind) {
    case "read":
      return "read";
    case "write":
      return "workspace-write";
    case "fetch":
      return "network";
    case "spawn":
      return "process";
    case "system":
      return "system-change";
    case "delete":
      return operation.irreversible ? "destructive" : "workspace-write";
  }
}

export interface PermissionContext {
  /** Whether the DSH permission system approved this operation. */
  approved: boolean;
  /** Extra guard for destructive operations; must be explicitly enabled. */
  destructiveAllowed?: boolean;
}

/**
 * Decide whether an operation may proceed. Returns true when allowed,
 * false when approval is missing, and throws for blocked destructive ops.
 */
export function assertPermission(
  mutationClass: MutationClass,
  context: PermissionContext,
): boolean {
  if (mutationClass === "read") return true;
  if (mutationClass === "destructive") {
    if (!context.destructiveAllowed) throw new DestructiveOperationError();
    return context.approved;
  }
  return context.approved;
}
