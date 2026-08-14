# Review — reviewer-a (deepseek via claude cli)

- Verdict: **approve**
- Confidence: 0.8

## Blocking
(none)

## Non-blocking
- PLUGIN_STANDARD.md defines Capability as an object ({ name, description? }) and PluginMetadata.capabilities as Capability[], but the shipped contract kit (packages/core/src/plugin/types.ts) types capabilities as readonly string[] (the ast-grep plugin ships capabilities: ["ast-search:js", ...]). The doc claims the contract kit enforces the standard 'mechanically', so a plugin author following the doc will fail the enforcement it promises. One of the doc or the type must be reconciled.
- PLUGIN_STANDARD.md specifies execute(args, ctx) but never defines ctx (ToolContext). The implementation defines ToolContext = { workspaceRoot, run }, but the binding contract is silent on what ctx carries, leaving plugin authors guessing whether ctx exposes the runner, the workspace root, or permission state.
- ResultSummary is documented as { count, bySeverity, topIssues, truncated, rawRef? } but the enforcement type requires an additional tool: string field; TopIssue is referenced (TopIssue[]) but never given a shape anywhere in the standard.
- BinaryInfo.source is described inconsistently across the two docs: ARCHITECTURE.md says 'source (PATH / explicit)' while PLUGIN_STANDARD.md says source: "npm-package" | "path" | "detected". Two different value sets for the same field.
- MutationClass 'read' (gate: none) vs 'process' (gate: DSH permission) is under-specified: every read tool still spawns an external binary via the core runner, so nothing in the standard states the rule that distinguishes a gated process-class tool from a read tool that executes a short-lived subprocess. Without a concrete rule, 'permission classes declared correctly' is not mechanically checkable.
- The MutationClass gate column for 'read' is 'none', but the ast-grep read adapter executes a third-party binary whose argv is influenced by model input; the docs never state that read-class tools still run under the core runner's env-allowlist/timeout/output-cap rules (they do implicitly via rule 1-3, but the gating table can be read as read = fully ungated).

## Security
- The read/process classification boundary (above) is a potential permission-gating bypass: a plugin author can classify any side-effecting or process-spawning tool as 'read' and legitimately skip the DSH permission gate, because the standard gives no observable distinguishing rule (e.g., 'process' = long-lived or interactive; 'read' = fixed short-lived argv). The contract kit's 'permission classes declared correctly' assertion needs an explicit rule to be enforceable.
- ADR-005 decision 2 ('classes other than read require DSH permission approval before execution') and ARCHITECTURE.md data-flow step 2 assume a DSH permission-approval mechanism, but the pinned compatibility manifest records permission_hook_api as 'TBD — must be verified against the pinned commit ... do not fabricate'. The docs present the gate as settled architecture while the upstream API it depends on is unverified; the ADR should carry a dependency/risk note referencing the manifest TBD (as ADR-001/002 do for the pin).

## Test gaps
- tests/doc-contract.test.ts only asserts that 'resultSummary' appears and 'summaryBlock' does not, plus substring matches for the four severity words. It does not enforce the issue's own acceptance criteria: that all six ADRs contain status/context/decision/consequences, that all seven core types are defined, or that MutationClass covers all six classes.
- The severity assertions (/info/, /warning/, /error/, /critical/) are substring matches that would still pass if the severity union regressed (e.g. 'error' and 'critical' appear in error-code examples and field names, not just the severity set).
- No test guards cross-document consistency (e.g., the BinaryInfo.source mismatch between ARCHITECTURE.md and PLUGIN_STANDARD.md, or the Capability shape drift against packages/core/src/plugin/types.ts).

## Compatibility
- ADR-005 is recorded as Accepted while its core mechanism (DSH permission approval for non-read classes) depends on the permission hook API the pinned manifest explicitly marks TBD/unverified; the ADR should cross-reference the manifest field rather than assert an unverified upstream API as settled.
- ADR-001 lists 'pinned CI lane (ISSUE-027)' as the mitigation for upstream churn, but the CI workflow at this point only prints the pinned SHA; there is no lane exercising the pinned upstream commit yet. Acceptable as a forward reference, but the mitigation is currently absent and should be tracked.

## Architecture
- The docs define the contract for types (BinaryInfo, ExecutionRequest, ExecutionResult, Diagnostic, Capability, MutationClass, PluginMetadata, ResultSummary, ToolResult) that are not yet implemented in this PR, and at least one of them (Capability) already diverges from what the later contract kit enforces — the standard should be treated as a spec that must be re-synced when ISSUE-007 lands.
- The core type contract section in PLUGIN_STANDARD.md duplicates the Result contract section (Diagnostic appears twice with slightly different field descriptions); duplicated spec text is a maintenance risk the doc-contract test does not guard against.
- The 'process' MutationClass wording 'Runs/arbitrary long-lived processes' conflicts in tone with ADR-004 ('no arbitrary shell execution'); the standard should clarify what 'arbitrary' means in a typed-argv world.
