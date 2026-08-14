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
 * `node:child_process` import — named, aliased, namespace, plain/computed
 * member access, require destructuring, plain require binding, createRequire
 * (bound or inline chain) — so locally-defined functions named `exec` are
 * never flagged. It also tracks variable-held options objects, later `shell`
 * mutations, and object spreads of tracked options. This is defense-in-depth
 * static analysis, not a complete security boundary: the structural guarantee
 * is the core process runner API (spawn without a shell) that all plugins
 * must use. Earlier no-op/bypassable versions were found by external review
 * of PR #31; each reported form is covered by a regression test in
 * tests/eslint-adr004.test.ts.
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
    const CP = new Set(["node:child_process", "child_process"]);

    /** @type {Map<string,string>} local name -> imported child_process name */
    const bindings = new Map();
    /** @type {Set<string>} local names bound to the child_process module */
    const namespaces = new Set();
    /** @type {Set<string>} local names that are require functions */
    const requireFns = new Set();
    /** @type {Map<string,boolean|"unknown">} options var -> shell value */
    const shellOpts = new Map();

    /** Check whether an expression string-literal-equals one of CP sources. */
    /** @param {unknown} expr */
    function isChildProcessSource(expr) {
      if (expr == null || typeof expr !== "object") return false;
      const record = /** @type {Record<string, unknown>} */ (expr);
      return record.type === "Literal" && CP.has(String(record.value));
    }

    /**
     * @param {import("estree").ImportDeclaration | import("estree").VariableDeclaration} node
     */
    function trackBinding(node) {
      if (
        node.type === "ImportDeclaration" &&
        typeof node.source.value === "string" &&
        CP.has(node.source.value)
      ) {
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.imported.type === "Identifier") {
            bindings.set(spec.local.name, spec.imported.name);
          } else if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
          }
        }
      }
      if (node.type !== "VariableDeclaration") return;
      for (const decl of node.declarations) {
        const init = decl.init;
        if (!init) continue;

        // const opts = { shell: true }  (also shell: someExpr => "unknown")
        if (
          init.type === "ObjectExpression" &&
          decl.id.type === "Identifier"
        ) {
          for (const prop of init.properties) {
            if (
              prop.type === "Property" &&
              !prop.computed &&
              prop.key.type === "Identifier" &&
              prop.key.name === "shell"
            ) {
              const value =
                prop.value.type === "Literal" ? prop.value.value : "unknown";
              shellOpts.set(decl.id.name, value === false ? false : "unknown");
            }
          }
        }

        // const req = createRequire(import.meta.url)
        if (
          init.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          init.callee.name === "createRequire" &&
          decl.id.type === "Identifier"
        ) {
          requireFns.add(decl.id.name);
          continue;
        }

        // requireFn = require | createRequire-bound local
        const isRequireCall =
          init.type === "CallExpression" &&
          ((init.callee.type === "Identifier" && init.callee.name === "require") ||
            (init.callee.type === "Identifier" && requireFns.has(init.callee.name)));

        // const cp = require("node:child_process")  -> namespace
        if (
          isRequireCall &&
          isChildProcessSource(init.arguments[0]) &&
          decl.id.type === "Identifier"
        ) {
          namespaces.add(decl.id.name);
          continue;
        }

        // const { exec } = require("node:child_process")  -> bindings
        if (
          isRequireCall &&
          isChildProcessSource(init.arguments[0]) &&
          decl.id.type === "ObjectPattern"
        ) {
          for (const prop of decl.id.properties) {
            if (prop.type === "Property" && prop.key.type === "Identifier") {
              const local = prop.value.type === "Identifier" ? prop.value.name : undefined;
              if (local) bindings.set(local, prop.key.name);
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
      if (callee.type === "MemberExpression") {
        // object may be a namespace identifier, a plain require, or an
        // inline createRequire(...)(...) chain resolving to child_process.
        const object = callee.object;
        let namespace = false;
        if (object.type === "Identifier") {
          namespace = namespaces.has(object.name);
        } else if (object.type === "CallExpression") {
          namespace = isRequireNamespaceCall(object);
        }
        if (!namespace) return undefined;
        if (!callee.computed && callee.property.type === "Identifier") {
          return callee.property.name;
        }
        if (callee.computed && callee.property.type === "Literal") {
          return String(callee.property.value);
        }
      }
      return undefined;
    }

    /**
     * True when `expr` is a call that returns the child_process module:
     * require("node:child_process"), a createRequire-bound local called
     * with a child_process source, or an inline
     * createRequire(import.meta.url)("node:child_process") chain.
     * @param {import("estree").Expression} expr
     */
    function isRequireNamespaceCall(expr) {
      if (expr.type !== "CallExpression") return false;
      const c = expr.callee;
      if (c.type === "Identifier") {
        if (c.name === "require") {
          return isChildProcessSource(expr.arguments[0]);
        }
        return requireFns.has(c.name) && isChildProcessSource(expr.arguments[0]);
      }
      if (c.type === "CallExpression") {
        // inline createRequire(...)(...) producing a require function
        const inner = c.callee;
        return (
          inner.type === "Identifier" &&
          inner.name === "createRequire" &&
          isChildProcessSource(expr.arguments[0])
        );
      }
      return false;
    }

    /**
     * Track mutations like `o.shell = true` on a tracked options object.
     * @param {import("estree").AssignmentExpression} node
     */
    function trackOptionsMutation(node) {
      const left = node.left;
      if (
        left.type === "MemberExpression" &&
        left.object.type === "Identifier" &&
        shellOpts.has(left.object.name) &&
        left.property.type === "Identifier" &&
        left.property.name === "shell"
      ) {
        const value = node.right.type === "Literal" ? node.right.value : "unknown";
        shellOpts.set(left.object.name, value === false ? false : "unknown");
      }
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
      // Options may be the 2nd or 3rd argument: an inline object literal (or
      // spread of a tracked object), a variable-held object literal (tracked
      // above), or any combination. Report when shell is not literally false.
      for (const arg of call.arguments) {
        if (!arg) continue;
        if (arg.type === "ObjectExpression") {
          for (const prop of arg.properties) {
            if (prop.type === "SpreadElement") {
              if (prop.argument.type === "Identifier" && shellOpts.has(prop.argument.name)) {
                if (shellOpts.get(prop.argument.name) !== false) {
                  context.report({ node: call, messageId: "shellTrue", data: { fn: name } });
                }
              }
              continue;
            }
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
        } else if (arg.type === "Identifier" && shellOpts.has(arg.name)) {
          if (shellOpts.get(arg.name) !== false) {
            context.report({ node: call, messageId: "shellTrue", data: { fn: name } });
          }
        }
      }
    }

    return {
      ImportDeclaration: trackBinding,
      VariableDeclaration: trackBinding,
      AssignmentExpression: trackOptionsMutation,
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
