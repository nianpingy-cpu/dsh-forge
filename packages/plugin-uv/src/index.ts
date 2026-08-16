/**
 * uv read/process/write adapter (ISSUE-014).
 *
 * Typed tools compiled to uv argv[] — no shell, no free-form commands.
 * Read tools: uv_status, uv_tree. Process: uv_run, uv_sync, uv_python.
 * Write (workspace-write + network): uv_add, uv_remove (permission-gated).
 */
import {
  validateArgs,
  resolveInWorkspace,
  WorkspaceViolationError,
  assertPermission,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
} from "@dsh-forge/core";
import { resolveUvBinary, UV_BINARY_HINT } from "./binary.js";

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
    summary: `uv binary not found (${binary})`,
    error: { code: "BinaryNotFound", message: UV_BINARY_HINT },
  };
}

function workspaceViolation(target: string): ToolResult {
  return {
    ok: false,
    summary: "path escapes the workspace boundary",
    error: { code: "WorkspaceViolation", message: `rejected: ${target}` },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "uv failed",
    error: { code: "ToolFailure", message },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message:
        "this tool is a workspace-write/process mutation and requires permission approval",
    },
  };
}

/** Boundary-check an optional project directory (defaults to the workspace root). */
function resolveProject(
  workspaceRoot: string,
  projectDir: string | undefined,
): { ok: true; project: string } | { ok: false; result: ToolResult } {
  try {
    const project = resolveInWorkspace(
      workspaceRoot,
      projectDir ?? ".",
    );
    return { ok: true, project };
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return { ok: false, result: workspaceViolation(projectDir ?? ".") };
    }
    throw err;
  }
}

async function runUv(
  ctx: ToolContext,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; result: ToolResult }> {
  const binary = resolveUvBinary();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let execution;
  try {
    execution = await ctx.run({
      binary,
      args,
      cwd: opts.cwd ?? ctx.workspaceRoot,
      timeoutMs,
      // uv command output (esp. install logs) can be large.
      maxOutputBytes: 10 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, result: toolFailure(`uv runner threw: ${String(err)}`) };
  }
  if (execution.error?.code === "BinaryNotFound") {
    return { ok: false, result: binaryNotFound(binary) };
  }
  if (execution.timedOut || execution.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "uv timed out",
        error: {
          code: "Timeout",
          message: `uv exceeded the ${timeoutMs}ms execution timeout`,
        },
      },
    };
  }
  if (execution.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "uv output exceeded the output cap",
        error: {
          code: "ToolFailure",
          message: "uv output exceeded the 10 MiB output cap; the result was truncated",
        },
      },
    };
  }
  if (execution.error) {
    return { ok: false, result: toolFailure(execution.error.message) };
  }
  if (execution.exitCode !== 0) {
    const firstLine =
      execution.stderr.trim().split("\n").find((l) => l.trim() !== "") ??
      execution.stderr.trim().split("\n")[0] ??
      `exit code ${execution.exitCode}`;
    return { ok: false, result: toolFailure(firstLine) };
  }
  return { ok: true, stdout: execution.stdout, stderr: execution.stderr };
}

function okResult(summary: string, stdout: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: stdout.length > 20_000 ? stdout.slice(0, 20_000) + "\n...[truncated]" : stdout,
  };
}

const PATH_SCHEMA = {
  type: "string" as const,
  description:
    "workspace-relative path to the uv project (defaults to the workspace root)",
};

// ISSUE-014 permission mapping. MutationClass is single-valued; each tool is
// declared with the class of its *defining* side effect and the choice is
// documented here:
//   uv_status / uv_tree    -> read        (offline: --frozen, never re-resolves)
//   uv_python / uv_sync    -> network     (fetch managed Pythons / install deps)
//   uv_run                 -> process     (runs a command in the project env)
//   uv_add / uv_remove     -> workspace-write (rewrites pyproject.toml + lock)
// A host that gates `network` / `workspace-write` separately still surfaces
// approval for these tools; the network-capable ones are not under-gated.
const NETWORK_CLASS = "network" as const;
const WRITE_CLASS = "workspace-write" as const;

const uvStatus: ToolDefinition = {
  name: "uv_status",
  description:
    "Report the uv project's environment status (dry-run sync against the committed lockfile; read, offline via --frozen).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: { projectDir: PATH_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { projectDir } = validated.value as { projectDir?: string };
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    // --frozen keeps this a pure read: it compares against the committed
    // uv.lock and never re-resolves against the package index (no network).
    const run = await runUv(ctx, ["sync", "--dry-run", "--frozen"], {
      timeoutMs: 60_000,
      cwd: proj.project,
    });
    if (!run.ok) return run.result;
    const changes = (run.stdout + "\n" + run.stderr)
      .split("\n")
      .filter((l) => /^[+ -]\s/.test(l.trimStart()));
    const summary =
      changes.length > 0
        ? `environment out of sync: ${changes.length} package change(s) pending`
        : "environment in sync";
    return okResult(summary, run.stdout + run.stderr);
  },
};

const uvTree: ToolDefinition = {
  name: "uv_tree",
  description:
    "Display the uv project's dependency tree from the committed lockfile (read, offline via --frozen).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: { projectDir: PATH_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { projectDir } = validated.value as { projectDir?: string };
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    // --frozen: build the tree from the committed uv.lock (no network).
    const run = await runUv(ctx, ["tree", "--frozen"], {
      timeoutMs: 60_000,
      cwd: proj.project,
    });
    if (!run.ok) return run.result;
    const count = run.stdout.split("\n").filter((l) => l.trim() !== "").length;
    return okResult(`dependency tree (${count} node(s))`, run.stdout);
  },
};

const uvPython: ToolDefinition = {
  name: "uv_python",
  description:
    "Locate the Python interpreter uv would use for the project (network + process: may fetch managed Pythons).",
  mutationClass: NETWORK_CLASS,
  inputSchema: {
    type: "object",
    properties: { projectDir: PATH_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { projectDir } = validated.value as { projectDir?: string };
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    if (!assertPermission(NETWORK_CLASS, ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const run = await runUv(ctx, ["python", "find"], {
      timeoutMs: 60_000,
      cwd: proj.project,
    });
    if (!run.ok) return run.result;
    const path = run.stdout.trim();
    return okResult(`python: ${path}`, run.stdout);
  },
};

const uvSync: ToolDefinition = {
  name: "uv_sync",
  description:
    "Sync the uv project environment (install/update dependencies) (network + process, requires permission approval).",
  mutationClass: NETWORK_CLASS,
  inputSchema: {
    type: "object",
    properties: { projectDir: PATH_SCHEMA },
    required: [],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { projectDir } = validated.value as { projectDir?: string };
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    if (!assertPermission(NETWORK_CLASS, ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const run = await runUv(ctx, ["sync"], { cwd: proj.project });
    if (!run.ok) return run.result;
    const lastLine = (run.stdout.trim().split("\n").pop() ?? "").trim();
    return okResult(lastLine || "environment synced", run.stdout);
  },
};

const uvRun: ToolDefinition = {
  name: "uv_run",
  description:
    "Run a command inside the uv project's environment (process). The command is a typed argument list, never a shell string.",
  mutationClass: "process",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "command and arguments to run in the project environment",
      },
      projectDir: PATH_SCHEMA,
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { command, projectDir } = validated.value as {
      command: string[];
      projectDir?: string;
    };
    if (!Array.isArray(command) || command.length === 0) {
      return invalid("command must contain at least one argument");
    }
    for (const c of command) {
      if (typeof c !== "string" || c === "") {
        return invalid("command must contain only non-empty strings");
      }
    }
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    if (!assertPermission("process", ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const run = await runUv(ctx, ["run", ...command], { cwd: proj.project });
    if (!run.ok) return run.result;
    return okResult(`command exited 0: ${command[0]}`, run.stdout);
  },
};

const uvAdd: ToolDefinition = {
  name: "uv_add",
  description:
    "Add a package dependency to the uv project (workspace-write + network, requires permission approval).",
  mutationClass: WRITE_CLASS,
  inputSchema: {
    type: "object",
    properties: {
      packages: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "package spec(s) to add, e.g. httpx or requests>=2.0",
      },
      projectDir: PATH_SCHEMA,
    },
    required: ["packages"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { packages, projectDir } = validated.value as {
      packages: string[];
      projectDir?: string;
    };
    if (!Array.isArray(packages) || packages.length === 0) {
      return invalid("packages must contain at least one package spec");
    }
    for (const p of packages) {
      if (typeof p !== "string" || p === "" || p.trim().startsWith("-")) {
        return invalid(`invalid package spec: ${String(p)}`);
      }
    }
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    if (!assertPermission(WRITE_CLASS, ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const run = await runUv(ctx, ["add", ...packages], { cwd: proj.project });
    if (!run.ok) return run.result;
    return okResult(`added: ${packages.join(", ")}`, run.stdout);
  },
};

const uvRemove: ToolDefinition = {
  name: "uv_remove",
  description:
    "Remove a package dependency from the uv project (workspace-write + network, requires permission approval).",
  mutationClass: WRITE_CLASS,
  inputSchema: {
    type: "object",
    properties: {
      packages: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "package name(s) to remove",
      },
      projectDir: PATH_SCHEMA,
    },
    required: ["packages"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { packages, projectDir } = validated.value as {
      packages: string[];
      projectDir?: string;
    };
    if (!Array.isArray(packages) || packages.length === 0) {
      return invalid("packages must contain at least one package name");
    }
    for (const p of packages) {
      if (typeof p !== "string" || p === "" || p.trim().startsWith("-")) {
        return invalid(`invalid package name: ${String(p)}`);
      }
    }
    const proj = resolveProject(ctx.workspaceRoot, projectDir);
    if (!proj.ok) return proj.result;
    if (!assertPermission(WRITE_CLASS, ctx.permission ?? { approved: false })) {
      return permissionDenied();
    }
    const run = await runUv(ctx, ["remove", ...packages], { cwd: proj.project });
    if (!run.ok) return run.result;
    return okResult(`removed: ${packages.join(", ")}`, run.stdout);
  },
};

export const uvPlugin = {
  metadata: {
    name: "@dsh-forge/plugin-uv",
    version: "1.0.0",
    upstreamTool: "uv",
    coreContractVersion: "1.0.0",
    capabilities: [
      "project-status",
      "dependency-tree",
      "python-find",
      "env-sync",
      "project-run",
      "dependency-add",
      "dependency-remove",
    ],
  },
  tools: [uvStatus, uvTree, uvPython, uvSync, uvRun, uvAdd, uvRemove],
};

export { resolveUvBinary };
