# ADR-001: Native DSH plugins

Status: Accepted

## Context

DeepSeek Harness (DSH) is a Cordis-based harness where "everything is a
plugin". dsh-forge could integrate as an external MCP-style bridge or as
native DSH plugins.

## Decision

Implement plugins natively for DSH, targeting the commit pinned in
`compatibility/deepseek-harness.json`. All plugin packages keep their
tool logic in framework-agnostic adapters (`ToolDefinition[]`), with a thin
DSH registration layer that is re-verified against the pinned SHA.

## Consequences

+ First-class integration with DSH permissions and tool registry.
+ Adapter core stays testable without a running harness.
− Upstream breaking changes require re-verification; mitigated by the
  compatibility manifest and pinned CI lane (ISSUE-027).
