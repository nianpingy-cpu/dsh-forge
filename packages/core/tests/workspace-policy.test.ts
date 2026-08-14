import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    symlinkSync(outside, linkPath);
    expect(() => resolveInWorkspace(root, join("escape-link", "evil.txt"))).toThrow(
      WorkspaceViolationError,
    );
  });

  it("handles Windows-style backslash separators", () => {
    const resolved = resolveInWorkspace(root, "src\\a.ts");
    expect(resolved).toBe(resolve(root, "src", "a.ts"));
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
