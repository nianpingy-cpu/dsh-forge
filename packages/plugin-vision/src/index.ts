/**
 * Vision, data analysis & chart adapter (ISSUE-062).
 *
 * Developer-facing tools that help review UI screenshots, understand simple
 * client data-analysis requests, and turn data into charts — all offline and
 * deterministic:
 *
 *   vision_inspect  (read)             structural image heuristics
 *   data_analyze    (read)             CSV/JSON descriptive analysis
 *   chart_generate  (workspace-write)  pure-SVG chart file in the workspace
 *
 * The deterministic engine lives in `scripts/vision-worker.mjs`, spawned via
 * the current Node executable with typed argv[] (ADR-004, no arbitrary shell
 * execution) — the same node-shim pattern as plugin-biome. Writes are
 * workspace-gated (workspace-write) with an overwrite guard and workspace
 * boundary enforcement (ADR-005). Model-based design review is a configured
 * backend capability; structural heuristics always run offline.
 */
import {
  validateArgs,
  assertPermission,
  resolveInWorkspace,
  WorkspaceViolationError,
  parseJsonOutput,
  toDiagnostic,
  summarizeDiagnostics,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ExecutionResult,
  type Diagnostic,
} from "@dsh-forge/core";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { resolveVisionWorker, VISION_WORKER_HINT } from "./binary.js";

/** Input files larger than this are rejected before any whole-file read. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const CHART_TYPES = ["bar", "line", "pie", "area", "scatter"] as const;

function invalid(message: string): ToolResult {
  return {
    ok: false,
    summary: "invalid arguments",
    error: { code: "InvalidArguments", message },
  };
}

function permissionDenied(): ToolResult {
  return {
    ok: false,
    summary: "permission denied",
    error: {
      code: "PermissionDenied",
      message: "chart writes require explicit approval (workspace-write)",
    },
  };
}

function toolFailure(message: string): ToolResult {
  return {
    ok: false,
    summary: "vision tool failed",
    error: { code: "ToolFailure", message },
  };
}

/** True when the string contains control characters (\x00-\x1f, \x7f). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Reject empty, leading-dash or control-character paths (flag injection). */
function isValidPathInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !/^\s*-/.test(value) &&
    !hasControlChars(value)
  );
}

/** Cap on text inputs passed through argv (task/title) to bound argv size. */
const MAX_TEXT_INPUT = 2000;

/** Reject empty/oversize/leading-dash/control-char text inputs. */
function isValidTextInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT_INPUT &&
    !/^\s*-/.test(value) &&
    !hasControlChars(value)
  );
}

type Exec = ExecutionResult & { exitCode: number };

/**
 * Run the vision worker (node <worker> <subcommand> ...) through the core
 * runner. Only BinaryNotFound, Timeout, truncated output, runner errors and
 * signal-death (null exit code) fail here; a non-zero exit code is passed
 * through so callers can interpret the worker's JSON error document.
 */
async function runWorker(
  ctx: ToolContext,
  subcommand: string,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; exec: Exec } | { ok: false; result: ToolResult }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const workerPath = resolveVisionWorker();
  // A genuinely absent worker (e.g. a package installed without scripts/)
  // must surface as BinaryNotFound. Checking before spawn keeps the real
  // runner path deterministic: node itself would otherwise spawn fine and
  // emit a module-not-found error with empty stdout, which parseWorker would
  // misread as a ParseFailure instead of BinaryNotFound.
  if (!existsSync(workerPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker not found",
        error: { code: "BinaryNotFound", message: VISION_WORKER_HINT },
      },
    };
  }
  let exec: ExecutionResult;
  try {
    // No `env` is passed: core's DEFAULT_ENV_ALLOWLIST applies to every
    // child (never the full inherited environment), so harness secrets can
    // never reach the worker while it reads untrusted files.
    exec = await ctx.run({
      binary: process.execPath,
      args: [workerPath, subcommand, ...args],
      cwd: ctx.workspaceRoot,
      timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      result: toolFailure(`vision worker runner threw: ${String(err)}`),
    };
  }
  if (exec.error?.code === "BinaryNotFound") {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker not found",
        error: { code: "BinaryNotFound", message: VISION_WORKER_HINT },
      },
    };
  }
  if (exec.timedOut || exec.aborted) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker timed out",
        error: {
          code: "Timeout",
          message: `vision worker exceeded the ${timeoutMs}ms timeout`,
        },
      },
    };
  }
  if (exec.truncated) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker output exceeded the cap",
        error: {
          code: "ToolFailure",
          message: "vision worker output exceeded the 8 MiB output cap",
        },
      },
    };
  }
  if (exec.error) {
    return { ok: false, result: toolFailure(exec.error.message) };
  }
  if (exec.exitCode === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker terminated abnormally",
        error: {
          code: "ToolFailure",
          message: "vision worker was killed or crashed (no exit code)",
        },
      },
    };
  }
  return { ok: true, exec: { ...exec, exitCode: exec.exitCode } };
}

/**
 * Parse the worker's JSON document. Worker-reported failures (non-zero exit
 * with `{ ok:false, error }`) are normalized to ToolFailure; malformed output
 * is a ParseFailure.
 */
function parseWorker(
  tool: string,
  exec: Exec,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: ToolResult } {
  const parsed = parseJsonOutput(tool, exec.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker parse failed",
        error: { code: "ParseFailure", message: parsed.error },
      },
    };
  }
  const value = parsed.value as Record<string, unknown>;
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker parse failed",
        error: {
          code: "ParseFailure",
          message: `${tool}: expected a JSON object`,
        },
      },
    };
  }
  if (exec.exitCode !== 0 || value.ok !== true) {
    const werr = value.error as
      { code?: unknown; message?: unknown } | undefined;
    const wcode = typeof werr?.code === "string" ? werr.code : "ToolFailure";
    const wmsg =
      typeof werr?.message === "string" ? werr.message : "vision worker failed";
    // Preserve the normalized error code when the worker's own code maps onto
    // a ToolError code; unknown worker codes flatten to ToolFailure.
    const mapped =
      wcode === "InvalidArguments" || wcode === "ParseFailure"
        ? wcode
        : "ToolFailure";
    return {
      ok: false,
      result: {
        ok: false,
        summary: "vision worker failed",
        error: { code: mapped, message: `${wcode}: ${wmsg}` },
      },
    };
  }
  return { ok: true, value };
}

/** Map the worker's diagnostics array onto core Diagnostics + summaryBlock. */
function attachDiagnostics(
  tool: string,
  raw: unknown,
): {
  diagnostics?: Diagnostic[];
  summaryBlock?: ReturnType<typeof summarizeDiagnostics>;
} {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const diagnostics = raw.map((d) =>
    toDiagnostic(tool, (d ?? {}) as Record<string, unknown>),
  );
  return {
    diagnostics,
    summaryBlock: summarizeDiagnostics(tool, diagnostics),
  };
}

/** Resolve a workspace-relative input path; never throws. */
function resolveInput(
  ctx: ToolContext,
  path: string,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(path)) {
    return {
      ok: false,
      result: invalid("input must be a non-empty workspace path"),
    };
  }
  let absolute: string;
  try {
    absolute = resolveInWorkspace(ctx.workspaceRoot, path);
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${path}` },
        },
      };
    }
    return {
      ok: false,
      result: toolFailure(`input path could not be resolved: ${String(err)}`),
    };
  }
  // Reject non-regular inputs (FIFO/device would block a whole-file read) and
  // oversize files before the worker reads them.
  let inputStat: ReturnType<typeof statSync> | undefined;
  try {
    inputStat = statSync(absolute);
  } catch {
    inputStat = undefined;
  }
  if (inputStat !== undefined && !inputStat.isFile()) {
    return {
      ok: false,
      result: invalid(
        "input must be a regular file (FIFOs, sockets, devices and directories are not supported)",
      ),
    };
  }
  if (inputStat !== undefined && inputStat.size > MAX_INPUT_BYTES) {
    return {
      ok: false,
      result: invalid(
        `input file exceeds the ${MAX_INPUT_BYTES / (1024 * 1024)} MiB limit`,
      ),
    };
  }
  return { ok: true, absolute };
}

/** Resolve a workspace-relative output path with an overwrite guard. */
function resolveOutput(
  ctx: ToolContext,
  output: string,
  overwrite: boolean,
): { ok: true; absolute: string } | { ok: false; result: ToolResult } {
  if (!isValidPathInput(output)) {
    return {
      ok: false,
      result: invalid("output must be a non-empty workspace path"),
    };
  }
  let absolute: string;
  try {
    absolute = resolveInWorkspace(ctx.workspaceRoot, output);
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "path escapes the workspace boundary",
          error: { code: "WorkspaceViolation", message: `rejected: ${output}` },
        },
      };
    }
    return {
      ok: false,
      result: toolFailure(`output path could not be resolved: ${String(err)}`),
    };
  }
  if (!overwrite && existsSync(absolute)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "output exists",
        error: {
          code: "ToolFailure",
          message: `output already exists: ${output}; set overwrite=true to replace it`,
        },
      },
    };
  }
  return { ok: true, absolute };
}

function okResult(summary: string, raw: string): ToolResult {
  return {
    ok: true,
    summary,
    raw: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...[truncated]" : raw,
  };
}

const visionInspect: ToolDefinition = {
  name: "vision_inspect",
  description:
    "Inspect a UI screenshot or image (PNG/JPEG/WebP/GIF/BMP) and return structural diagnostics: format, dimensions, aspect ratio, and color/contrast heuristics (read-only). Model-based design review is a configured-backend capability; structural heuristics always run offline.",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "workspace-relative path to an image file",
      },
      task: {
        type: "string",
        description:
          "optional analysis request; model-based review requires a configured vision backend",
      },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { input, task } = validated.value as { input: string; task?: string };
    const resolved = resolveInput(ctx, input);
    if (!resolved.ok) return resolved.result;
    const workerArgs = ["--image", resolved.absolute];
    if (task !== undefined && task !== "") {
      if (!isValidTextInput(task)) {
        return invalid("task must be a non-empty text string");
      }
      workerArgs.push("--task", task);
    }
    const run = await runWorker(ctx, "inspect", workerArgs, {
      timeoutMs: 60_000,
    });
    if (!run.ok) return run.result;
    const parsed = parseWorker("vision_inspect", run.exec);
    if (!parsed.ok) return parsed.result;
    const data = parsed.value;
    const format = typeof data.format === "string" ? data.format : "?";
    const width = typeof data.width === "number" ? data.width : null;
    const height = typeof data.height === "number" ? data.height : null;
    const stats = data.stats as
      { luminanceStddev?: number; meanLuminance?: number } | null | undefined;
    const contrast =
      typeof stats?.luminanceStddev === "number"
        ? `, contrast ${stats.luminanceStddev}`
        : "";
    const dims = width !== null && height !== null ? ` ${width}x${height}` : "";
    const summary = `inspected ${input}: ${format}${dims}${contrast}`;
    const attached = attachDiagnostics("vision_inspect", data.diagnostics);
    const result: ToolResult = {
      ...okResult(summary, JSON.stringify(data, null, 2)),
      ...attached,
    };
    return result;
  },
};

const dataAnalyze: ToolDefinition = {
  name: "data_analyze",
  description:
    "Analyze a CSV or JSON data file and return a structured summary: row/column counts, schema, per-column descriptive statistics, and lightweight diagnostics (read-only).",
  mutationClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "workspace-relative path to a CSV or JSON data file",
      },
    },
    required: ["data"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const { data } = validated.value as { data: string };
    const resolved = resolveInput(ctx, data);
    if (!resolved.ok) return resolved.result;
    const run = await runWorker(ctx, "analyze", ["--data", resolved.absolute]);
    if (!run.ok) return run.result;
    const parsed = parseWorker("data_analyze", run.exec);
    if (!parsed.ok) return parsed.result;
    const d = parsed.value;
    const format = typeof d.format === "string" ? d.format : "?";
    const rows = typeof d.rows === "number" ? d.rows : 0;
    const columns = typeof d.columns === "number" ? d.columns : 0;
    const summary = `analyzed ${data}: ${format}, ${rows} row(s) x ${columns} column(s)`;
    const attached = attachDiagnostics("data_analyze", d.diagnostics);
    const result: ToolResult = {
      ...okResult(summary, JSON.stringify(d, null, 2)),
      ...attached,
    };
    return result;
  },
};

const chartGenerate: ToolDefinition = {
  name: "chart_generate",
  description:
    "Generate a chart from CSV/JSON data or an inline series and write an SVG file into the workspace (workspace-write; no overwrite unless overwrite=true).",
  mutationClass: "workspace-write",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "workspace-relative CSV/JSON data file (label, value)",
      },
      series: {
        type: "array",
        items: { type: "object" },
        description: "inline series: [{ label, value }]",
        minItems: 1,
      },
      type: {
        type: "string",
        enum: [...CHART_TYPES],
        description: "chart type",
      },
      title: {
        type: "string",
        description: "optional chart title",
      },
      width: {
        type: "number",
        description: "output width in px (100-4096, default 800)",
      },
      height: {
        type: "number",
        description: "output height in px (100-4096, default 400)",
      },
      output: {
        type: "string",
        description: "workspace-relative output file (.svg)",
      },
      overwrite: {
        type: "boolean",
        description: "replace the output if it exists",
      },
    },
    required: ["type", "output"],
  },
  async execute(args, ctx) {
    const validated = validateArgs(this.inputSchema, args);
    if (!validated.ok) return invalid(validated.error);
    const a = validated.value as {
      data?: string;
      series?: unknown[];
      type: string;
      title?: string;
      width?: number;
      height?: number;
      output: string;
      overwrite?: boolean;
    };
    if (
      !assertPermission(
        "workspace-write",
        ctx.permission ?? { approved: false },
      )
    ) {
      return permissionDenied();
    }
    const hasData = a.data !== undefined && a.data !== "";
    const hasSeries = Array.isArray(a.series) && a.series.length > 0;
    if (!hasData && !hasSeries) {
      return invalid("chart requires either a data file or a series array");
    }
    if (Array.isArray(a.series) && a.series.length > 2000) {
      return invalid("series must contain at most 2000 points");
    }
    if (a.title !== undefined && a.title !== "" && !isValidTextInput(a.title)) {
      return invalid("title must be a non-empty text string");
    }
    if (
      a.width !== undefined &&
      (!Number.isInteger(a.width) || a.width < 100 || a.width > 4096)
    ) {
      return invalid("width must be an integer between 100 and 4096");
    }
    if (
      a.height !== undefined &&
      (!Number.isInteger(a.height) || a.height < 100 || a.height > 4096)
    ) {
      return invalid("height must be an integer between 100 and 4096");
    }
    const overwrite = a.overwrite === true;
    const output = resolveOutput(ctx, a.output, overwrite);
    if (!output.ok) return output.result;
    // Create missing parent directories so nested outputs like
    // "charts/sales.svg" work; the path is already verified inside the
    // workspace and the write is gated by workspace-write.
    try {
      mkdirSync(dirname(output.absolute), { recursive: true });
    } catch (err) {
      return toolFailure(`could not create output directory: ${String(err)}`);
    }

    const workerArgs = ["--type", a.type, "--out", output.absolute];
    if (hasData) {
      const resolved = resolveInput(ctx, a.data as string);
      if (!resolved.ok) return resolved.result;
      workerArgs.push("--data", resolved.absolute);
    } else {
      workerArgs.push("--series", JSON.stringify(a.series));
    }
    if (a.title !== undefined && a.title !== "")
      workerArgs.push("--title", a.title);
    if (a.width !== undefined) workerArgs.push("--width", String(a.width));
    if (a.height !== undefined) workerArgs.push("--height", String(a.height));

    const run = await runWorker(ctx, "chart", workerArgs);
    if (!run.ok) return run.result;
    const parsed = parseWorker("chart_generate", run.exec);
    if (!parsed.ok) return parsed.result;
    const d = parsed.value;
    const chartType = typeof d.chartType === "string" ? d.chartType : a.type;
    const w = typeof d.width === "number" ? d.width : "?";
    const h = typeof d.height === "number" ? d.height : "?";
    const points = typeof d.dataPoints === "number" ? d.dataPoints : 0;
    const summary = `wrote ${a.output}: ${chartType} ${w}x${h}, ${points} point(s)`;
    return okResult(summary, JSON.stringify(d, null, 2));
  },
};

export const visionPlugin: {
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
    name: "@dsh-forge/plugin-vision",
    version: "1.0.0",
    upstreamTool: "node (vision-worker.mjs)",
    coreContractVersion: "1.0.0",
    capabilities: [
      "image-inspect",
      "data-analyze",
      "chart-generate",
      "workspace-write",
    ],
  },
  tools: [visionInspect, dataAnalyze, chartGenerate],
};

export { resolveVisionWorker };

export default visionPlugin;
