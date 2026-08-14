# ADR-003: Structured diagnostics

Status: Accepted

## Context

Linters and scanners emit thousands of lines of terminal text. Feeding raw
output to the model wastes context and hides signal.

## Decision

All finding-producing tools (Ruff, Biome, Semgrep, Trivy, ast-grep) normalize
output into the shared `Diagnostic` shape and return a compressed
`ResultSummary` (counts by severity, top issues, truncated flag, raw
reference). Raw output is retained as a capped reference, never returned
wholesale. Machine-readable CLI output (JSON) is the primary parse source;
terminal-text regex parsing is a flagged last resort.

## Consequences

+ Uniform reasoning surface across ten tools; predictable token cost.
− Per-tool normalizers must track upstream JSON schemas (tested with
  fixtures).
