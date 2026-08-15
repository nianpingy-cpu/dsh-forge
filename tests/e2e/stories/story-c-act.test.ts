import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runProcess, type ToolContext } from "@dsh-forge/core";
import { actPlugin, resolveActBinary } from "@dsh-forge/plugin-act";
import { binaryAvailable, daemonAvailable } from "./env.js";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/e2e/act-workspace", import.meta.url),
);

const PASSING = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Pass
        run: echo "hello from dsh-act-passing"
`;

const tool = (name: string) =>
  actPlugin.tools.find((t) => t.name === name)!;

const ctx = (workspaceRoot: string): ToolContext => ({
  workspaceRoot,
  run: runProcess,
  permission: { approved: true },
});

let workspaceRoot: string;

// act executes workflows in containers via Docker, so both are required.
const hasActEnv =
  binaryAvailable(resolveActBinary()) && daemonAvailable("docker", ["version"]);

// Story C: GitHub Actions -> act -> failure -> fix -> pass.
describe.skipIf(!hasActEnv)("story C: GitHub Actions -> act -> failure -> fix -> pass", () => {
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-c-"));
    cpSync(FIXTURES, workspaceRoot, { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it(
    "runs a failing workflow, fixes it, and runs it green",
    async () => {
      const failing = await tool("act_run").execute({}, ctx(workspaceRoot));
      expect(failing.ok).toBe(false);
      expect(failing.error?.code).toBe("ToolFailure");

      // fix the workflow so the step passes
      writeFileSync(
        join(workspaceRoot, ".github", "workflows", "ci.yml"),
        PASSING,
        "utf8",
      );

      const passing = await tool("act_run").execute({}, ctx(workspaceRoot));
      expect(passing.ok).toBe(true);
    },
    600_000,
  );
});
