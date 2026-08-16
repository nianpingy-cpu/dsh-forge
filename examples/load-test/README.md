# Example: load-test

k6 performance and load testing workflow.

## Scenario

Run smoke, load, and stress tests with threshold verification.

## Required binaries

- `k6` — <https://github.com/grafana/k6/releases>

## Steps

```text
1. k6_smoke(script: "tests/smoke.js")               # process: quick check
2. k6_load(script: "tests/load.js", vus: 50, duration: "2m")
                                                     # process: load test
3. k6_stress(script: "tests/stress.js", vus: 200, duration: "5m")
                                                     # process: stress test
4. k6_summary(path: "summary.json")                 # read: parse summary
5. k6_threshold_check(path: "summary.json")         # read: verify thresholds
```

## Expected result

Performance characteristics are measured and thresholds are verified; exit 1
from k6 means thresholds were not met (still a completed run).

## Permissions

Run tools are `process` and require permission approval; summary/threshold
tools are read-only.
