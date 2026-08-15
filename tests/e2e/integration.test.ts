import { describe, expect, it, beforeAll } from "vitest";
import { cpSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runProcess,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";
import { ruffPlugin, resolveRuffBinary } from "@dsh-forge/plugin-ruff";
import { createHost } from "./host.js";

const FIXTURES = fileURLToPath(
  new URL("../../fixtures/ruff", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

const realRunner: ExecutionRunner = (req) => runProcess(req);

const ctx = (): ToolContext => ({
  workspaceRoot,
  run: realRunner,
  permission: { approved: true },
});

let hasRealRuff = false;
try {
  hasRealRuff = statSync(resolveRuffBinary()).isFile();
} catch {
  // not installed
}

describe("deterministic no-API integration (ISSUE-013)", () => {
  describe("host registration (no binary required)", () => {
    it("rejects a call to an unregistered tool with a canonical error", async () => {
      const host = createHost(ctx());
      host.load([ruffPlugin]);
      const res = await host.call("does_not_exist", {});
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("InvalidArguments");
    });

    it("refuses to register the same tool name twice", async () => {
      const host = createHost(ctx());
      host.load([ruffPlugin]);
      expect(() => host.load([ruffPlugin])).toThrow(
        /duplicate tool registration/i,
      );
    });
  });

  // Visible skip (not a silent pass) when Ruff is absent locally; CI installs
  // Ruff and the CI-prerequisite test below fails if it ever goes missing, so
  // the real-binary roundtrip is always exercised in CI.
  describe.skipIf(!hasRealRuff)("real binary roundtrip", () => {
    it(
      "loads a real plugin and a typed tool call returns a canonical structured result",
      async () => {
        // 1. plugin loads
        expect(ruffPlugin.metadata.name).toBe("@dsh-forge/plugin-ruff");

        // 2. tool registers through the host
        const host = createHost(ctx());
        host.load([ruffPlugin]);
        expect(host.toolNames).toContain("ruff_check");

        // 3. typed call -> canonical structured result (real Ruff binary)
        const clean = await host.call("ruff_check", { paths: ["clean.py"] });
        expect(clean.ok).toBe(true);
        expect(clean.diagnostics?.length ?? 0).toBe(0);
        expect(typeof clean.summary).toBe("string");

        // a file with lint findings returns ok:true with normalized diagnostics
        const violations = await host.call("ruff_check", {
          paths: ["sample.py"],
        });
        expect(violations.ok).toBe(true);
        expect(violations.diagnostics).toBeDefined();
        expect(violations.diagnostics!.length).toBeGreaterThan(0);
      },
      30_000,
    );
  });

  describe("CI fixture prerequisites", () => {
    it("CI installs Ruff so the real-binary E2E runs (never silently skipped)", () => {
      if (!process.env.CI) return; // local machines may not have Ruff
      expect(
        hasRealRuff,
        "CI must install ruff (see .github/workflows/ci.yml) so the real-binary E2E is exercised",
      ).toBe(true);
    });
  });
});
