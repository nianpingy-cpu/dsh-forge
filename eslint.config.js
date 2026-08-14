// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ADR-004 enforcement: no arbitrary shell execution.
 *
 * - spawn/spawnSync/execFile/execFileSync bound to `node:child_process` with
 *   `shell: true` (or an unknown/non-literal shell value) → error
 * - exec/execSync bound to `node:child_process` (always run through a shell) → error
 *
 * The rule is binding-aware: it only reports calls whose callee resolves to a
 * `node:child_process` import (named, aliased, namespace, or require
 * destructuring), so locally-defined functions named `exec` are never flagged
 * and member-expression / aliased-import bypasses are caught. Two earlier
 * versions (an esquery selector and a plain-name visitor) were found by
 * external review of PR #31 to be no-ops or bypassable.
 */
const noShellExecRule = {
  meta: {
    messages: {
      shellTrue:
        "ADR-004: child_process {{fn}} with shell: true is forbidden. Use binary + argv[] with shell: false (default).",
      execAlways:
        "ADR-004: child_process {{fn}} always executes through a shell. Use spawn/execFile with argv[] instead.",
    },
  },
  /** @param {import("eslint").Rule.RuleContext} context */
  create(context) {
    const SHELL_OPTIONAL = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
    const ALWAYS_SHELL = new Set(["exec", "execSync"]);
    /** @type {Map<string,string>} local name -> imported child_process name */
    const bindings = new Map();
    /** @type {Set<string>} local names bound to the child_process namespace */
    const namespaces = new Set();

    /**
     * @param {import("estree").ImportDeclaration | import("estree").VariableDeclaration} node
     */
    function trackBinding(node) {
      if (
        node.type === "ImportDeclaration" &&
        typeof node.source.value === "string" &&
        (node.source.value === "node:child_process" || node.source.value === "child_process")
      ) {
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.imported.type === "Identifier") {
            bindings.set(spec.local.name, spec.imported.name);
          } else if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
          }
        }
      }
      if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
          const init = decl.init;
          if (
            init &&
            init.type === "CallExpression" &&
            init.callee.type === "Identifier" &&
            init.callee.name === "require" &&
            init.arguments[0] &&
            init.arguments[0].type === "Literal" &&
            (init.arguments[0].value === "node:child_process" ||
              init.arguments[0].value === "child_process") &&
            decl.id.type === "ObjectPattern"
          ) {
            for (const prop of decl.id.properties) {
              if (prop.type === "Property" && prop.key.type === "Identifier") {
                const local =
                  prop.value.type === "Identifier" ? prop.value.name : undefined;
                if (local) bindings.set(local, prop.key.name);
              }
            }
          }
        }
      }
    }

    /**
     * Resolve the imported child_process name for a call, or undefined if the
     * callee is not bound to child_process.
     * @param {import("estree").CallExpression} call
     */
    function resolveChildProcessName(call) {
      const callee = call.callee;
      if (callee.type === "Identifier") {
        return bindings.get(callee.name);
      }
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.type === "Identifier"
      ) {
        return callee.property.name;
      }
      return undefined;
    }

    /** @param {import("estree").CallExpression} call */
    function check(call) {
      const name = resolveChildProcessName(call);
      if (!name) return;
      if (ALWAYS_SHELL.has(name)) {
        context.report({ node: call, messageId: "execAlways", data: { fn: name } });
        return;
      }
      if (!SHELL_OPTIONAL.has(name)) return;
      // Options may be the 2nd or 3rd argument. Scan every object argument
      // for a `shell` key: literal `true` or any non-literal value is
      // reported (unknown shell mode is treated as unsafe).
      for (const arg of call.arguments) {
        if (!arg || arg.type !== "ObjectExpression") continue;
        for (const prop of arg.properties) {
          if (
            prop.type === "Property" &&
            !prop.computed &&
            prop.key.type === "Identifier" &&
            prop.key.name === "shell"
          ) {
            const isLiteralFalse =
              prop.value.type === "Literal" && prop.value.value === false;
            if (!isLiteralFalse) {
              context.report({ node: call, messageId: "shellTrue", data: { fn: name } });
            }
          }
        }
      }
    }

    return {
      ImportDeclaration: trackBinding,
      VariableDeclaration: trackBinding,
      CallExpression: check,
    };
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
