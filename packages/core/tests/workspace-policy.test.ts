import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import {
  resolveInWorkspace,
  WorkspaceViolationError,
  classifyMutation,
  assertPermission,
  DestructiveOperationError,
} from "@dsh-forge/core";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-ws-"));
  outside = mkdtempSync(join(tmpdir(), "dsh-out-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export {}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("accepts a relative path inside the workspace", () => {
    const resolved = resolveInWorkspace(root, join("src", "a.ts"));
    expect(resolved).toBe(resolve(root, "src", "a.ts"));
  });

  it("accepts an absolute path inside the workspace", () => {
    const resolved = resolveInWorkspace(root, resolve(root, "src", "a.ts"));
    expect(resolved.startsWith(resolve(root))).toBe(true);
  });

  it("rejects ../ escape", () => {
    expect(() => resolveInWorkspace(root, join("..", "evil.txt"))).toThrow(
      WorkspaceViolationError,
    );
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveInWorkspace(root, join(outside, "evil.txt"))).toThrow(
      WorkspaceViolationError,
    );
  });

  it("rejects a nested ../ escape", () => {
    expect(() =>
      resolveInWorkspace(root, join("src", "..", "..", "evil.txt")),
    ).toThrow(WorkspaceViolationError);
  });

  it("rejects symlink escape", () => {
    const linkPath = join(root, "escape-link");
    // Windows directory symlinks need admin/dev-mode; junctions are the
    // platform-standard directory link and exercise the same escape path.
    if (process.platform === "win32") {
      symlinkSync(outside, linkPath, "junction");
    } else {
      symlinkSync(outside, linkPath);
    }
    expect(() => resolveInWorkspace(root, join("escape-link", "evil.txt"))).toThrow(
      WorkspaceViolationError,
    );
  });

  it("handles Windows-style backslash separators", () => {
    const resolved = resolveInWorkspace(root, "src\\a.ts");
    expect(resolved).toBe(resolve(root, "src", "a.ts"));
  });

  // ---- regression: workspace boundary findings from review of PR #35 ----

  it("rejects a case-colliding sibling path on case-sensitive filesystems", () => {
    // On case-sensitive filesystems (Linux/macOS) a sibling directory whose
    // name differs only by case must NOT be treated as inside the workspace.
    // A naive toLowerCase() containment check would treat it as contained.
    if (process.platform === "win32") return; // case-insensitive fs: untestable
    const base = basename(root); // e.g. "dsh-ws-abc123"
    const altBase = base.replace(/[a-z]/gi, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    if (altBase === base) return; // no letters to toggle (should not happen)
    const alt = join(dirname(root), altBase);
    mkdirSync(alt, { recursive: true });
    try {
      expect(() =>
        resolveInWorkspace(root, join(alt, "evil.txt")),
      ).toThrow(WorkspaceViolationError);
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("returns a canonicalized path, not the symlinked candidate", () => {
    // Containment is verified against the realpath, so the returned write
    // target must be that same canonical location — otherwise a symlink swap
    // between check and write escapes the workspace (TOCTOU).
    const linkPath = join(root, "src-link");
    if (process.platform === "win32") {
      symlinkSync(join(root, "src"), linkPath, "junction");
    } else {
      symlinkSync(join(root, "src"), linkPath);
    }
    try {
      const resolved = resolveInWorkspace(root, join("src-link", "a.ts"));
      expect(resolved).toBe(resolve(root, "src", "a.ts"));
    } finally {
      rmSync(linkPath, { recursive: true, force: true });
    }
  });

  it("rejects a dangling symlink instead of misjudging containment", () => {
    const danglingDir = join(root, "dangling-dir");
    const target = join(outside, "does-not-exist");
    try {
      if (process.platform === "win32") {
        // junction requires an existing target; a broken junction can't be
        // created reliably, so exercise a non-writable-ancestor variant only
        // on POSIX.
        return;
      }
      symlinkSync(target, danglingDir);
      expect(() =>
        resolveInWorkspace(root, join("dangling-dir", "evil.txt")),
      ).toThrow();
    } finally {
      rmSync(danglingDir, { recursive: true, force: true });
    }
  });
});

describe("classifyMutation / assertPermission", () => {
  it("read operations need no approval", () => {
    expect(classifyMutation({ kind: "read" })).toBe("read");
    expect(assertPermission("read", { approved: false })).toBe(true);
  });

  it("workspace-write requires approval", () => {
    expect(assertPermission("workspace-write", { approved: false })).toBe(false);
    expect(assertPermission("workspace-write", { approved: true })).toBe(true);
  });

  it("network / process / system-change require approval", () => {
    for (const mc of ["network", "process", "system-change"] as const) {
      expect(assertPermission(mc, { approved: false })).toBe(false);
      expect(assertPermission(mc, { approved: true })).toBe(true);
    }
  });

  it("destructive requires approval AND the destructive guard", () => {
    expect(() =>
      assertPermission("destructive", {
        approved: true,
        destructiveAllowed: false,
      }),
    ).toThrow(DestructiveOperationError);
    expect(
      assertPermission("destructive", {
        approved: true,
        destructiveAllowed: true,
      }),
    ).toBe(true);
  });

  it("classifies operation descriptors to mutation classes", () => {
    expect(classifyMutation({ kind: "write", target: "src/a.ts" })).toBe(
      "workspace-write",
    );
    expect(classifyMutation({ kind: "fetch", url: "https://x" })).toBe("network");
    expect(classifyMutation({ kind: "spawn", command: "uv" })).toBe("process");
    expect(classifyMutation({ kind: "system", target: "docker" })).toBe(
      "system-change",
    );
    expect(classifyMutation({ kind: "delete", irreversible: true })).toBe(
      "destructive",
    );
  });
});
