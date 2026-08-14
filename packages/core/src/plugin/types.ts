/**
 * Plugin and tool contracts (ISSUE-007, docs/PLUGIN_STANDARD.md).
 */
import type { Diagnostic, ResultSummary } from "../diagnostics/types.js";
import type { MutationClass, PermissionContext } from "../workspace/policy.js";
import type { ExecutionRequest, ExecutionResult } from "../process/runner.js";

export interface ToolContext {
  workspaceRoot: string;
  /** Core process runner — plugins must execute binaries through this. */
  run: (request: ExecutionRequest) => Promise<ExecutionResult>;
  /**
   * Permission state provided by the DSH host. Mutating tools (mutationClass
   * workspace-write and above) must gate side effects on this; absent or
   * unapproved means the mutation is denied (PermissionDenied).
   */
  permission?: PermissionContext;
}

export interface ToolError {
  code:
    | "InvalidArguments"
    | "BinaryNotFound"
    | "Timeout"
    | "WorkspaceViolation"
    | "PermissionDenied"
    | "ToolFailure"
    | "ParseFailure";
  message: string;
}

export interface ToolResult {
  ok: boolean;
  /** Compact model-facing summary. */
  summary: string;
  diagnostics?: Diagnostic[];
  /** Compressed model-facing view for large diagnostic sets. */
  summaryBlock?: ResultSummary;
  /** Capped raw output, reference only. */
  raw?: string;
  error?: ToolError;
}

export interface InputSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "array" | "object";
      description?: string;
      enum?: readonly string[];
      items?: { type: string };
      /** For array properties: minimum number of elements. */
      minItems?: number;
    }
  >;
  required?: readonly string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  mutationClass: MutationClass;
  inputSchema: InputSchema;
  execute: (this: ToolDefinition, args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface PluginMetadata {
  name: string;
  version: string;
  upstreamTool: string;
  /** Must equal CORE_VERSION of the core package the plugin targets. */
  coreContractVersion: string;
  capabilities: readonly string[];
}

export interface Plugin {
  metadata: PluginMetadata;
  tools: readonly ToolDefinition[];
}

export type ValidationOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Validate typed arguments against a tool's input schema. */
export function validateArgs(
  schema: InputSchema,
  args: unknown,
): ValidationOutcome {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  const record = args as Record<string, unknown>;
  for (const field of schema.required ?? []) {
    if (!(field in record)) {
      return { ok: false, error: `missing required field: ${field}` };
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const spec = schema.properties[key];
    if (!spec) {
      return { ok: false, error: `unknown field: ${key}` };
    }
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== spec.type) {
      return {
        ok: false,
        error: `field ${key} must be ${spec.type}, got ${actualType}`,
      };
    }
    if (spec.enum && !spec.enum.includes(String(value))) {
      return {
        ok: false,
        error: `field ${key} must be one of: ${spec.enum.join(", ")}`,
      };
    }
    if (
      spec.type === "array" &&
      spec.minItems !== undefined &&
      Array.isArray(value) &&
      value.length < spec.minItems
    ) {
      return {
        ok: false,
        error: `field ${key} must contain at least ${spec.minItems} item(s)`,
      };
    }
  }
  return { ok: true, value: record };
}
