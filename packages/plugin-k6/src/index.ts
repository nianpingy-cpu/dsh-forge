/**
 * k6 adapter (ISSUE-022) — load-testing tools.
 *
 * Typed tools compiled to k6 argv[] — no shell, no free-form commands.
 *   k6_version           (read)     k6 version
 *   k6_run               (process)  k6 run <script> [--vus N] [--duration D]
 *   k6_smoke             (process)  k6 run <script> --vus 1 --duration <short>
 *   k6_load              (process)  k6 run <script> --vus <N> --duration <D>
 *   k6_stress            (process)  k6 run <script> --vus <N> --duration <D>
 *   k6_summary           (read)     parse a k6 --summary-export JSON file
 *   k6_threshold_check   (read)     evaluate thresholds in a k6 summary JSON
 *
 * Script generation stays with the agent; the plugin only executes/parses.
 *
 * (RED — the tools below are not implemented yet; tests are failing.)
 */
import { type ToolDefinition } from "@dsh-forge/core";
import { resolveK6Binary, K6_BINARY_HINT } from "./binary.js";

export const k6Plugin: {
  metadata: {
    name: string;
    version: string;
    upstreamTool: string;
    coreContractVersion: string;
    capabilities: readonly string[];
  };
  tools: readonly ToolDefinition[];
} = {
  metadata: {
    name: "@dsh-forge/plugin-k6",
    version: "0.1.0",
    upstreamTool: "k6",
    coreContractVersion: "0.1.0",
    capabilities: [
      "version",
      "run",
      "smoke",
      "load",
      "stress",
      "summary",
      "threshold-check",
      "process",
    ],
  },
  tools: [],
};

export { resolveK6Binary, K6_BINARY_HINT };

export default k6Plugin;
