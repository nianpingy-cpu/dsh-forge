import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  runProcess,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";
import { resolvePresetOrThrow } from "@dsh-forge/presets";
import { resolveRuffBinary } from "@dsh-forge/plugin-ruff";
import { createHost } from "./host.js";

const FIXTURES = fileURLToPath(
  new URL("../../fixtures/ruff", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-roundtrip-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
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

// Deterministic host-shim E2E. Real DeepSeek Harness integration (Cordis
// plugin loading, host/client aggregation, DSH permission hook) is a BLOCKED
// sub-task for V0.1.0: the pinned compatibility manifest lists the DSH
// permission_hook_api as TBD, so no real-harness assertions can be made yet.
// This shim proves the preset -> registration -> typed-call -> canonical
// result flow deterministically, without claiming to be the real harness.
describe("host-shim E2E (deterministic; real DSH integration is a blocked sub-task)", () => {
  describe("preset resolution (no binary required)", () => {
    it("unknown preset fails to load (no plugin code duplication, config only)", () => {
      expect(() => resolvePresetOrThrow("not-a-preset")).toThrow(
        /unknown preset/i,
      );
    });
  });

  // Visible skip (not a silent pass) when Ruff is absent locally; the CI
  // prerequisite test in integration.test.ts fails if CI ever drops Ruff, so
  // this real roundtrip always runs in CI and asserts actual success.
  describe.skipIf(!hasRealRuff)("real roundtrip", () => {
    it(
      "loads a preset, registers every tool, and routes a typed call to a canonical success result",
      async () => {
        // load preset -> every plugin/tool registered
        const preset = resolvePresetOrThrow("python");
        const host = createHost(ctx());
        host.load(preset.plugins);
        for (const plugin of preset.plugins) {
          for (const tool of plugin.tools) {
            expect(host.toolNames).toContain(tool.name);
          }
        }
        expect(host.toolNames.length).toBe(
          preset.plugins.reduce((n, p) => n + p.tools.length, 0),
        );

        // model calls a tool with typed args -> canonical structured success
        const res = await host.call("ruff_check", { paths: ["clean.py"] });
        expect(res.ok).toBe(true);
        expect(res.diagnostics?.length ?? 0).toBe(0);
        expect(typeof res.summary).toBe("string");
      },
      30_000,
    );
  });
});
