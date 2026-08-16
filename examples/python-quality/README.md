# Example: python-quality

Ruff + uv quality workflow for a Python project.

## Scenario

Lint, format-check, fix, and manage a Python project's environment and
dependencies.

## Required binaries

- `ruff` — `pip install ruff`
- `uv` — `pip install uv`

## Steps

```text
1. ruff_check(paths: ["src"])            # read: lint findings
2. ruff_format_check(paths: ["src"])     # read: format check
3. ruff_fix(paths: ["src"])              # workspace-write: apply fixes
4. uv_status(projectDir: ".")            # read: project state
5. uv_sync(projectDir: ".")              # network: sync environment
6. ruff_check(paths: ["src"])            # verify: 0 errors
```

## Expected result

A Python project that lints clean, is formatted, and has a synced
environment.

## Permissions

`ruff_fix` and `uv_sync` require permission approval; the check/status steps
are read-only.
