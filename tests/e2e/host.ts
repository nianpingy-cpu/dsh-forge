import type {
  Plugin,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@dsh-forge/core";

/**
 * A minimal DeepSeek Harness-style host shim used by the E2E tests
 * (ISSUE-013): it loads plugins, registers their tools, and routes typed
 * tool calls through the core contract to a canonical ToolResult — exactly
 * the "load plugin -> register tool -> model calls tool -> structured
 * result" flow the harness drives, without any model API dependency.
 */
export interface HostedTool {
  name: string;
  definition: ToolDefinition;
  /** Route a typed call through the core contract. */
  call: (args: unknown) => Promise<ToolResult>;
}

export interface Host {
  readonly toolNames: readonly string[];
  /** Register every tool from every plugin; duplicate names throw. */
  load(plugins: readonly Plugin[]): Host;
  /** Route a typed call to a registered tool (canonical ToolResult). */
  call(name: string, args: unknown): Promise<ToolResult>;
}

export function createHost(ctx: ToolContext): Host {
  const tools = new Map<string, HostedTool>();
  return {
    get toolNames() {
      return [...tools.keys()];
    },
    load(plugins) {
      for (const plugin of plugins) {
        for (const definition of plugin.tools) {
          if (tools.has(definition.name)) {
            throw new Error(`duplicate tool registration: ${definition.name}`);
          }
          tools.set(definition.name, {
            name: definition.name,
            definition,
            call: (args) => definition.execute.call(definition, args, ctx),
          });
        }
      }
      return this;
    },
    async call(name, args) {
      const tool = tools.get(name);
      if (!tool) {
        return {
          ok: false,
          summary: `no registered tool named ${name}`,
          error: {
            code: "InvalidArguments",
            message: `no registered tool named ${name}`,
          },
        };
      }
      return tool.call(args);
    },
  };
}
