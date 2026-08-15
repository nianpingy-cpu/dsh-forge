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
 * Docker does not read repo-planted config from its cwd (unlike act's .actrc
 * or trivy's .trivyignore), so commands run from the workspace root with no
 * runtime-dir scaffolding. All read tools are un-gated (mutationClass
 * "read"); none of them modify state.
 */
import {
  validateArgs,
  resolveInWorkspace,
  WorkspaceViolationError,
  parseJsonOutput,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ExecutionResult,
} from "@dsh-forge/core";
import { statSync } from "node:fs";
import { resolveDockerBinary, DOCKER_BINARY_HINT } from "./binary.js";

const TOOL = "docker";

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function binaryNotFound(binary: string): ToolResult {
  return {
    ok: false,
    summary: `docker binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: DOCKER_BINARY_HINT },
  };
}

/**
 * Redact embedded credentials from docker CLI output before it reaches the
 * model: URLs like https://<token>@host/... and user:pass@host sequences
 * (registry auth echoes a registry URL into stderr on failure).
 */
function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@")
    .replace(/([A-Za-z0-9_.-]+):([^@\s/]+)@/g, "$1:***@");
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "docker failed",
    error: { code: "ToolFailure", message: redactCredentials(message) },
  };
}

function dockerUnavailable(reason: string): ToolResult {
  return {
    ok: false,
    summary: "docker unavailable",
    error: {
      code: "ToolFailure",
      message: redactCredentials(
        `Docker is not available: ${reason || "unknown reason"}`,
      ),
    },
  };
}

/** First non-empty stderr line (credential-redacted) or a stable fallback. */
function firstErrorLine(exitCode: number, stderr: string): string {
  const line = stderr.trim().split("\n").find((l) => l.trim() !== "");
  return redactCredentials(line ?? `docker exited with code ${exitCode}`);
}

/** Success execution with a guaranteed non-null exit code. */
type DockerExec = ExecutionResult & { exitCode: number };

/**
 * Run a docker CLI command through the core runner. Only BinaryNotFound,
 * Timeout, truncated output, runner errors and signal-death (null exit code)
 * fail here; a non-zero exit code is passed through so callers can interpret
 * it (e.g. "daemon not reachable").
 */
async function runDocker(
  ctx: ToolContext,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<
  { ok: true; exec: DockerExec } | { ok: false; result: ToolResult }
> {
  const binary = resolveDockerBinary();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let exec: ExecutionResult;
  try {
    exec = await ctx.run({
      binary,
      args: [...args],
      cwd: ctx.workspaceRoot,
      timeoutMs,
      maxOutputBytes: 10 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, result: toolFailure(`docker runner threw: ${String(err)}`) };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (exec.timedOut || exec.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "docker timed out",
        error: { code: "Timeout", message: `docker exceeded the ${timeoutMs}ms timeout` },
      },
    };
  }
  if (exec.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "docker output exceeded the cap",
        error: {
          code: "ToolFailure",
          message:
            "docker output exceeded the 10 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (exec.error) {
    return { ok: false, result: toolFailure(exec.error.message) };
  }
  if (exec.exitCode === null) {
    // A null exit code means docker died from a signal (OOM-kill, segfault)
    // without a clean exit — never report that as a valid empty result.
    return {
      ok: false,
      result: {
        ok: false,
        summary: "docker terminated abnormally",
        error: {
          code: "ToolFailure",
          message:
            "docker was killed or crashed (no exit code); the result is unreliable",
        },
      },
    };
  }
  return { ok: true, exec: { ...exec, exitCode: exec.exitCode as number } };
}

function okResult(summary: string, raw: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...[truncated]" : raw,
  };
}

/**
 * Parse docker's line-delimited `--format '{{json .}}'` output (one JSON
 * object per line). Empty output is an empty array. A line that is not a JSON
 * object is a ParseFailure — a security tool must never silently drop
 * unparseable output into a false-negative "0 items" result.
 */
function parseJsonLines(
  stdout: string,
): { ok: true; items: unknown[] } | { ok: false; result: ToolResult } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return { ok: true, items: [] };
  const items: unknown[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "docker parse failed",
          error: {
            code: "ParseFailure",
            message: `docker: malformed JSON output line: ${line.slice(0, 120)}`,
          },
        },
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "docker parse failed",
          error: {
            code: "ParseFailure",
            message: "docker: expected a JSON object per output line",
          },
        },
      };
    }
    items.push(parsed);
  }
  return { ok: true, items };
}

function itemsResult(what: string, items: unknown[]): ToolResult {
  const raw = JSON.stringify(items, null, 2);
  const summary = `${items.length} ${what}(s)`;
  return okResult(summary, raw);
}

/**
 * Parse compose `ps` output: `docker compose ps --format json` emits a single
 * JSON *array* (pretty-printed or single-line), while a `{{json .}}` template
 * emits one JSON object per line. Accept both so the tool works against real
 * compose v2 regardless of formatting.
 */
function parseJsonArrayOrLines(
  stdout: string,
): { ok: true; items: unknown[] } | { ok: false; result: ToolResult } {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // not a whole-document array; fall through to line parsing
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return {
            ok: false,
            result: {
              ok: false,
              summary: "docker parse failed",
              error: {
                code: "ParseFailure",
                message: "docker: expected a JSON object per compose service entry",
              },
            },
          };
        }
      }
      return { ok: true, items: parsed };
    }
  }
  return parseJsonLines(stdout);
}

/** Reject empty or leading-dash container/image names (flag injection). */
function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !/\s/.test(value)
  );
}

/**
 * Reject empty or leading-dash workspace paths (flag injection). Spaces are
 * legal in paths and safe as a single argv element, so they are allowed here
 * (unlike container names, which docker itself forbids from containing
 * whitespace).
 */
function isValidPathInput(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && !/^\s*-/.test(value)
  );
}

const dockerStatus: ToolDefinition = {
  name: "docker_status",
  description:
    "Check Docker daemon availability and report the server version (read-only).",
  mutationClass: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const run = await runDocker(ctx, ["info", "--format", "{{.ServerVersion}}"]);
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return dockerUnavailable(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const version = run.exec.stdout.trim();
    return okResult(
      version ? `docker available (server ${version})` : "docker available",
      version || "(no server version reported)",
    );
  },
};

const dockerPs: ToolDefinition = {
  name: "docker_ps",
  description:
    "List Docker containers (running and, by default, stopped) as a JSON array (read-only).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      all: {
        type: "boolean",
        description: "include stopped containers (default true)",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { all } = validated.value as { all?: boolean };
    const run = await runDocker(
      ctx,
      all === false
        ? ["ps", "--format", "{{json .}}"]
        : ["ps", "-a", "--format", "{{json .}}"],
    );
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const parsed = parseJsonLines(run.exec.stdout);
    if (!parsed.ok) return parsed.result;
    return itemsResult("container", parsed.items);
  },
};

const dockerImages: ToolDefinition = {
  name: "docker_images",
  description:
    "List local Docker images as a JSON array (read-only).",
  mutationClass: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const run = await runDocker(ctx, ["images", "--format", "{{json .}}"]);
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const parsed = parseJsonLines(run.exec.stdout);
    if (!parsed.ok) return parsed.result;
    return itemsResult("image", parsed.items);
  },
};

const dockerInspect: ToolDefinition = {
  name: "docker_inspect",
  description:
    "Inspect a Docker container/image by name or ID; returns the JSON inspection array (read-only).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "container or image name/ID to inspect",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { name } = validated.value as { name: string };
    if (!isValidName(name)) {
      return invalid("name must be a non-empty container/image name or ID");
    }
    const run = await runDocker(ctx, ["inspect", name]);
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const parsed = parseJsonOutput(TOOL, run.exec.stdout);
    if (!parsed.ok) {
      return {
        ok: false,
        summary: "docker parse failed",
        error: { code: "ParseFailure", message: parsed.error },
      };
    }
    return okResult(
      `inspected ${name}`,
      JSON.stringify(parsed.value, null, 2),
    );
  },
};

const dockerLogs: ToolDefinition = {
  name: "docker_logs",
  description:
    "Fetch the most recent log lines from a container (read-only; uses docker logs --tail).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "container name/ID to read logs from",
      },
      tail: {
        type: "number",
        description: "number of most-recent lines to fetch (default 100)",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { name, tail } = validated.value as { name: string; tail?: number };
    if (!isValidName(name)) {
      return invalid("name must be a non-empty container name/ID");
    }
    const tailN = tail ?? 100;
    if (!Number.isInteger(tailN) || tailN <= 0) {
      return invalid("tail must be a positive integer");
    }
    const run = await runDocker(ctx, ["logs", "--tail", String(tailN), name]);
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    // `docker logs` forwards the container's stdout to the CLI stdout and its
    // stderr to the CLI stderr; most runtimes (nginx, app loggers) write to
    // stderr, so returning only stdout would silently drop most logs. Merge
    // both streams into raw.
    const combined = run.exec.stdout + run.exec.stderr;
    return okResult(
      `logs for ${name} (last ${tailN} lines)`,
      combined,
    );
  },
};

const dockerComposeStatus: ToolDefinition = {
  name: "docker_compose_status",
  description:
    "Show the status of services in a docker compose project as a JSON array (read-only).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "workspace-relative path to a compose file or project directory (default: workspace root)",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { path } = validated.value as { path?: string };
    let argv: string[];
    if (path !== undefined) {
      if (!isValidPathInput(path)) {
        return invalid("path must be a non-empty workspace path");
      }
      let absolute: string;
      try {
        absolute = resolveInWorkspace(ctx.workspaceRoot, path);
      } catch (err) {
        if (err instanceof WorkspaceViolationError) {
          return {
            ok: false,
            summary: "path escapes the workspace boundary",
            error: {
              code: "WorkspaceViolation",
              message: `rejected: ${path}`,
            },
          };
        }
        throw err;
      }
      const isDir = (() => {
        try {
          return statSync(absolute).isDirectory();
        } catch {
          return false;
        }
      })();
      // A directory selects the compose project; a file is passed with -f.
      // --project-directory / -f are explicit absolute paths, so no repo
      // config can re-target the scan.
      argv = isDir
        ? ["compose", "--project-directory", absolute, "ps", "--format", "json"]
        : ["compose", "-f", absolute, "ps", "--format", "json"];
    } else {
      argv = ["compose", "ps", "--format", "json"];
    }
    const run = await runDocker(ctx, argv);
    if (!run.ok) return run.result;
    if (run.exec.exitCode !== 0) {
      return toolFailure(firstErrorLine(run.exec.exitCode, run.exec.stderr));
    }
    const parsed = parseJsonArrayOrLines(run.exec.stdout);
    if (!parsed.ok) return parsed.result;
    return itemsResult("service", parsed.items);
  },
};

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
  tools: [
    dockerStatus,
    dockerPs,
    dockerImages,
    dockerInspect,
    dockerLogs,
    dockerComposeStatus,
  ],
};

export { resolveDockerBinary, DOCKER_BINARY_HINT };

export default dockerPlugin;
