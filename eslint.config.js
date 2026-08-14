// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "NewExpression[callee.name='spawn'][arguments.1.value.shell=true]",
          message:
            "shell: true is forbidden in dsh-forge. Use binary + argv[] (ADR-004).",
        },
      ],
    },
  },
);
