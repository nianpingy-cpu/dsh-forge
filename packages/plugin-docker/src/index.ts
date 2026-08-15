/**
 * Docker adapter (ISSUE-020) — read-only Docker inspection tools.
 *
 * Typed tools compiled to docker argv[] — no shell, no free-form commands.
 * All tools are read-only:
 *   docker_status           (read)  docker info --format {{.ServerVersion}}
 *   docker_ps               (read)  docker ps [-a] --format '{{json .}}'
 *   docker_images           (read)  docker images --format '{{json .}}'
 *   docker_inspect          (read)  docker inspect <name>
 *   docker_logs             (read)  docker logs --tail <n> <name>
 *   docker_compose_status   (read)  docker compose [-f|--project-directory] ps --format json
 *
 * (RED — the tools below are not implemented yet; tests are failing.)
 */
import { type ToolDefinition } from "@dsh-forge/core";
import { resolveDockerBinary, DOCKER_BINARY_HINT } from "./binary.js";

export const dockerPlugin: {
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
    name: "@dsh-forge/plugin-docker",
    version: "0.1.0",
    upstreamTool: "docker",
    coreContractVersion: "0.1.0",
    capabilities: [
      "status",
      "ps",
      "images",
      "inspect",
      "logs",
      "compose-status",
      "read-only",
    ],
  },
  tools: [],
};

export { resolveDockerBinary, DOCKER_BINARY_HINT };

export default dockerPlugin;
