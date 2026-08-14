/**
 * Workspace boundary and permission policy (ISSUE-006, ADR-005).
 *
 * Any write operation must resolve inside the workspace root. Traversal
 * (`..`), absolute-path escape, and symlink escape are rejected by default.
 * Side-effecting mutation classes require explicit approval; destructive
 * operations additionally require the destructive guard.
 */
import { realpathSync } from "node:fs";
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
 * Symlinks are resolved to their real paths before the boundary check.
 */
export function resolveInWorkspace(root: string, target: string): string {
  const workspaceRoot = realpathSync(root);
  const candidate = isAbsolute(target)
    ? resolve(target)
    : resolve(workspaceRoot, target);

  // Resolve the deepest existing ancestor of the candidate so symlinked
  // directories are canonicalized before containment is checked.
  const realCandidate = realpathOfDeepestExisting(candidate);
  const realRoot = realpathOfDeepestExisting(workspaceRoot);

  const normalizedCandidate = realCandidate.toLowerCase();
  const normalizedRoot = realRoot.toLowerCase();
  const contained =
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + sep.toLowerCase());

  if (!contained) {
    throw new WorkspaceViolationError(target);
  }
  return candidate;
}

function realpathOfDeepestExisting(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return current; // reached filesystem root
      current = parent;
    }
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
