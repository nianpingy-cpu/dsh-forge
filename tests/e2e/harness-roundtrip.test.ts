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

describe("real DSH E2E (load plugin, model calls tool, structured result)", () => {
  it("loads a preset, registers every tool, and routes a typed call to a canonical result", async () => {
    if (!hasRealRuff) return; // CI installs Ruff; skip elsewhere

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

    // model calls a tool with typed args -> canonical structured result
    const res = await host.call("ruff_check", { paths: ["broken.py"] });
    expect(typeof res.ok).toBe("boolean");
    expect(typeof res.summary).toBe("string");
    if (!res.ok) {
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBeDefined();
    }
  });

  it("unknown preset fails to load (no plugin code duplication, config only)", () => {
    expect(() => resolvePresetOrThrow("not-a-preset")).toThrow(
      /unknown preset/i,
    );
  });
});
