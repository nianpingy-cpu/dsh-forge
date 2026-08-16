# Example: local-ci

act local GitHub Actions workflow execution.

## Scenario

Discover and run GitHub Actions workflows locally before pushing.

## Required binaries

- `act` — <https://github.com/nektos/act/releases>
- Docker (for dry-run / run)

## Steps

```text
1. act_list_workflows()          # read: discover workflows
2. act_list_jobs()               # read: discover jobs
3. act_dry_run()                 # process: validate without running
4. act_run()                     # system-change: run workflow
5. act_failure_summary(log: "...")  # read: parse a failure log
```

## Expected result

Local CI runs reproduce GitHub Actions behavior; failures are parsed into a
summary.

## Permissions

`act_run` / `act_run_job` are system-change and require explicit approval.
