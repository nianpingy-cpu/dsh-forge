# Example: web-quality

Biome + ast-grep quality workflow for a JavaScript/TypeScript project.

## Scenario

Lint, format, and structurally refactor a web codebase.

## Required binaries

- `biome` — `npm install -D @biomejs/biome`
- ast-grep (`sg`) — `npm install -D @ast-grep/cli`

## Steps

```text
1. biome_check(paths: ["src"])                       # read: lint + format
2. biome_format_check(paths: ["src"])                # read: format check
3. ast_search(pattern: "console.$A", language: "ts", paths: ["src"])
                                                     # read: find usages
4. ast_rewrite(mode: "preview", pattern: "...", replacement: "...", language: "ts", paths: ["src"])
                                                     # workspace-write: preview
5. biome_fix(paths: ["src"])                         # workspace-write: apply fixes
6. biome_check(paths: ["src"])                       # verify: clean
```

## Expected result

A web project that is linted, formatted, and refactored with structural
precision.

## Permissions

`biome_fix` and `ast_rewrite` (apply) require permission approval.
