import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runProcess, type ToolContext } from "@dsh-forge/core";
import { dockerPlugin, resolveDockerBinary } from "@dsh-forge/plugin-docker";
import { k6Plugin, resolveK6Binary } from "@dsh-forge/plugin-k6";
import { binaryAvailable, daemonAvailable, waitForHttp } from "./env.js";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/e2e/container-app", import.meta.url),
);

const dTool = (name: string) =>
  dockerPlugin.tools.find((t) => t.name === name)!;
const kTool = (name: string) =>
  k6Plugin.tools.find((t) => t.name === name)!;

const ctx = (workspaceRoot: string): ToolContext => ({
  workspaceRoot,
  run: runProcess,
  permission: { approved: true },
});

let workspaceRoot: string;

const hasDockerEnv =
  binaryAvailable(resolveDockerBinary()) &&
  daemonAvailable("docker", ["version"]);
const hasK6 = binaryAvailable(resolveK6Binary());

// Story D: container app -> Docker (compose) -> k6 load test -> perf result.
describe.skipIf(!hasDockerEnv || !hasK6)("story D: container app -> Docker -> k6 -> perf result", () => {
  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-d-"));
    cpSync(FIXTURES, workspaceRoot, { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it(
    "builds + runs the container, load-tests it with k6, then tears down",
    async () => {
      let upSucceeded = false;
      let downError: string | undefined;
      try {
        const up = await dTool("docker_compose_up").execute(
          { path: "docker-compose.yml" },
          ctx(workspaceRoot),
        );
        upSucceeded = up.ok;
        expect(up.ok, up.error?.message).toBe(true);

        await waitForHttp("http://localhost:8080/", 90_000);

        const perf = await kTool("k6_run").execute(
          { script: "k6-load.js", vus: 5, duration: "5s" },
          ctx(workspaceRoot),
        );
        expect(perf.ok, perf.error?.message).toBe(true);
        // k6_run only reports "all thresholds passed" when k6 exited 0; exit
        // 1 (thresholds failed, e.g. p(95) > 1000ms) yields a different
        // summary, so this is a real performance assertion.
        expect(perf.summary).toMatch(/all thresholds passed/);
        // every request returned 200 (100% check pass rate)
        expect(perf.raw).toMatch(/checks[.:]+\s*100(?:\.0+)?%/);
      } finally {
        // Always attempt teardown — even when `up` failed (port conflict,
        // build/image-pull failure, container crash) — so no containers,
        // networks or the bound port are leaked/orphaned. Best-effort: a
        // teardown throw must not mask the root-cause error.
        try {
          const down = await dTool("docker_compose_down").execute(
            { path: "docker-compose.yml" },
            ctx(workspaceRoot),
          );
          if (upSucceeded) expect(down.ok, down.error?.message).toBe(true);
        } catch (err) {
          downError = String(err);
        }
      }
      // Only reachable when the body succeeded: surface a teardown failure.
      if (downError !== undefined) {
        throw new Error(`compose teardown failed: ${downError}`);
      }
    },
    600_000,
  );
});
