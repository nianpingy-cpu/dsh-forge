# Review — reviewer-a (deepseek via claude cli)

- Verdict: **approve**
- Confidence: 0.75

## Blocking
(none)

## Non-blocking
- validateArgs (plugin/types.ts) accepts null for object-typed fields — `typeof null === "object"` passes the type check, so `{obj: null}` against an object field is treated as valid. It also declares `items` in InputSchema but never validates array element types, so `{tags: [1,2]}` passes a string-array schema. This weakens the 'invalid args rejected' contract the whole kit depends on.
- Check 9 runs the binary probe with a hardcoded `{}` instead of `options.toolArgs[probe].valid` — any probe tool whose schema has required fields can never pass the binary-missing check, forcing plugin authors to design artificial no-argument probe tools.
- The check 6/7 try/catch only records a failed 'typed args accepted' when execute throws; the 'canonical result' and 'model-facing render' checks are silently omitted from the report, so a throwing tool yields an incomplete (non-exhaustive) ContractReport.
- The canonical-result check passes `{ok: true, ..., error: {code: ..., message: ...}}` — a contradictory ok:true-with-error result is never flagged even though the contract implies ok and error are mutually exclusive.
- The kit imposes no timeout on `tool.execute` and nothing on `ctx.run` calls that omit `timeoutMs` (runProcess only kills when timeoutMs is set) — a hung plugin tool stalls the whole suite until the host test framework's own per-test timeout fires, giving the plugin author a confusing signal.
- runContractSuite crashes with a TypeError (instead of returning a failed ContractReport) for malformed plugins: check 2 reads `plugin.metadata` without gating on check 1 (undefined/null plugin), and check 3 calls `plugin.tools.map` unconditionally (non-array tools).
- 'plugin loads' is cosmetic — the Plugin object is already materialized by the time it is passed in; a module that fails to load/export correctly fails at import time in the consuming test file, not in this check, and an undefined default export crashes the suite.
- Tool error normalization is only exercised for InvalidArguments (check 8) and BinaryNotFound (check 9); Timeout, WorkspaceViolation, PermissionDenied, ToolFailure, and ParseFailure mappings are never asserted, despite 'tool error normalization' being a stated kit assertion.
- The export-surface test regex-matches kit.ts source text (`/export\s*\{\s*validateArgs\b/`) — brittle to refactors (a multiline re-export list starting with a different name bypasses it) and tests an implementation detail rather than the runtime export surface.

## Security
- Checks 6 and 8 execute every tool's valid and invalid argument paths through the real runProcess by default (runner injection is opt-in). For destructive/network/system-change tools this can trigger genuine side effects — deletions, network calls, system changes — during the test run with no permission gate, dry-run, or guard; a non-validating tool is also invoked with the garbage invalid sample.
- renderModelFacing concatenates tool-controlled strings (summary, diagnostic messages, rule ids, file paths) verbatim without escaping newlines or control characters, so multi-line content from a tool is injected into the model-facing block — consistent with general tool-output handling, but the kit is itself a producer of model-facing text.

## Test gaps
- The `runner` option (injected mock for checks 6/8) is never exercised: the 'passes via the injected mock runner' test relies on check 9's internal mock, so the `options.runner ?? runProcess` wiring is untested.
- No negative tests for check 4 (schema valid), check 5 (permission class), check 7 (model-facing render), or check 10 (upstream binary declared).
- No test for a probe tool that does invoke ctx.run but maps BinaryNotFound to the wrong code — only never-invokes-runner stubs are covered.
- validateArgs has no unit tests for object-typed fields (null acceptance), array `items` enforcement, enum, or number/boolean coercion behavior — the null-for-object and items gaps are unguarded.
- No test documents or handles a binary probe with required schema fields (exposing the hardcoded `{}` limitation in check 9).

## Compatibility
- The kit validates a self-defined Plugin shape that is not yet verified against the pinned upstream DeepSeek Harness Cordis plugin/host API (manifest marks permission_hook_api as TBD) — conformance to the actual host is asserted by this kit, not proven.
- PR body claims CI on ubuntu+windows only; the kit spawns real node subprocesses and uses tmpdir-based temp dirs, so macOS behavior is unverified (low risk, but the claim is untested).

## Architecture
- validateArgs, a runtime value, lives in plugin/types.ts — a module named 'types' mixing runtime values and type exports; a separate validator module would match the layering of process/diagnostics/workspace.
- kit.ts imports CORE_VERSION from ../index.js while index.ts star-exports ./testing/kit.js — a circular module dependency that works only because CORE_VERSION is read lazily inside functions; fragile for bundlers and strict TS/native-ESM consumers.
- The kit is black-box: a plugin returning correctly-shaped canned results (plus one probe that calls ctx.run once) passes the entire suite without ever genuinely exercising the upstream binary — it proves contract shape, not real behavior. This is inherent to the design but should be documented so it is not read as proof of real execution.
- Checks 6/8 never verify that `execute` actually uses validateArgs or ctx.run; only the designated binary probe is forced to touch the runner, so non-validating, non-executing tools can pass all per-tool checks.
