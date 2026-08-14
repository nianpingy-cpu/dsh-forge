// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ADR-004 enforcement: no arbitrary shell execution.
 *
 * - spawn/spawnSync/execFile/execFileSync with `shell: true` → error
 * - exec/execSync (always run through a shell) → error
 *
 * Implemented as a real AST visitor. A previous version used an esquery
 * selector that could never match (NewExpression + arguments.1.value) and
 * silently enforced nothing — caught by external review of PR #31.
 */
const noShellExecRule = {
  meta: {
    messages: {
      shellTrue:
        "ADR-004: {{fn}} with shell: true is forbidden. Use binary + argv[] with shell: false (default).",
      execAlways:
        "ADR-004: {{fn}} always executes through a shell. Use spawn/execFile with argv[] instead.",
    },
  },
  /** @param {import("eslint").Rule.RuleContext} context */
  create(context) {
    const SHELL_OPTIONAL = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
    const ALWAYS_SHELL = new Set(["exec", "execSync"]);
    /**
     * @param {import("estree").CallExpression} call
     */
    function check(call) {
      if (call.callee.type !== "Identifier") return;
      const name = call.callee.name;
      if (ALWAYS_SHELL.has(name)) {
        context.report({ node: call, messageId: "execAlways", data: { fn: name } });
        return;
      }
      if (!SHELL_OPTIONAL.has(name)) return;
      // Options may be the 2nd or 3rd argument (exec: (cmd, opts);
      // spawn/execFile: (cmd, args, opts)). Scan every object argument.
      for (const arg of call.arguments) {
        if (!arg || arg.type !== "ObjectExpression") continue;
        for (const prop of arg.properties) {
          if (
            prop.type === "Property" &&
            !prop.computed &&
            prop.key.type === "Identifier" &&
            prop.key.name === "shell" &&
            prop.value.type === "Literal" &&
            prop.value.value === true
          ) {
            context.report({ node: call, messageId: "shellTrue", data: { fn: name } });
          }
        }
      }
    }
    return { CallExpression: check };
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/fixtures/**",
      "**/*.md",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "dsh-forge": { rules: { "no-shell-exec": noShellExecRule } },
    },
    rules: {
      "dsh-forge/no-shell-exec": "error",
    },
  },
);
