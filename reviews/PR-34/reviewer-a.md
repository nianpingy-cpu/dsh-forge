# Review — reviewer-a (deepseek via claude cli)

- Verdict: **approve**
- Confidence: 0.88

## Blocking
(none)

## Non-blocking
- {"file":"packages/core/src/diagnostics/types.ts","line":96,"summary":"normalizeSeverity only accepts string severities, so numeric severities (ESLint-style JSON: 1=warning, 2=error) silently fail-safe to 'error' — every warning from such tools is reclassified as an error in the model-facing summary. RawDiagnostic.severity is typed unknown, which invites exactly this input.","failure_scenario":"toDiagnostic('eslint', { severity: 1, message: 'no-unused-vars' }) returns severity 'error' instead of 'warning'; summarizeDiagnostics then reports error=N warnings=0, distorting the model's view of the run."}
- {"file":"packages/core/src/diagnostics/types.ts","line":161,"summary":"summarizeDiagnostics groups issues with an unescaped '|' delimiter (`${severity}|${rule}|${message}`), so a message containing '|' can collide with a different (rule, message) pair and silently merge groups, corrupting counts and topIssues.","failure_scenario":"Two diagnostics — {rule:'A', message:'B|C'} and {rule:'A|B', message:'C'} at the same severity — both produce key 'error|A|B|C' and are merged into one TopIssue with count 2 instead of two issues with count 1."}
- {"file":"packages/core/src/diagnostics/types.ts","line":157,"summary":"topN is used unguarded in slice(0, topN) and in the truncated computation; a negative topN returns the wrong slice (slice(0,-N)) and topN:0 yields empty topIssues while truncated=true for any non-empty set.","failure_scenario":"summarizeDiagnostics('x', ds, { topN: -2 }) slices off the last two entries of the sorted list, reporting topIssues that exclude the highest-count issues."}
- {"file":"packages/core/src/diagnostics/types.ts","line":62,"summary":"coerceNumber accepts floats, zero, and negatives for line/column (e.g. line: '12.5' → 12.5), which flows into the model-facing loc string `file:12.5` and can produce nonsensical locations.","failure_scenario":"A tool emitting line: '3.7' yields Diagnostic.line = 3.7; renderModelFacing prints `src/a.py:3.7`, which the model may interpret as an invalid line reference."}
- {"file":"packages/core/src/diagnostics/types.ts","line":175,"summary":"truncated is defined as diagnostics.length > topN (more findings than displayed top issues), which is unrelated to whether the underlying raw output was actually capped; the flag name invites misinterpretation in the summary contract.","failure_scenario":"A run with 6 findings and default topN=5 reports truncated:true even though nothing was dropped except the topIssues display window, while a run whose raw output was capped at the runner reports truncated:false."}
- {"file":"packages/core/src/diagnostics/types.ts","line":128,"summary":"parseJsonOutput and coerceString apply no size caps; a single huge JSON blob or an oversized message field is fully parsed/retained by this module, with correctness depending entirely on the caller's runner-level output cap.","failure_scenario":"A scanner emitting a 50 MB diagnostic message (or 100 MB of valid-but-garbage JSON) is fully materialized into Diagnostic/ResultSummary, defeating output caps if any caller invokes these functions before the runner truncates."}

## Security
- {"file":"packages/core/src/diagnostics/types.ts","line":128,"summary":"parseJsonOutput is a resource-exhaustion surface on unbounded input (single JSON.parse over the full text, no size guard). Not exploitable given the current runner caps, but the module itself enforces no bound and the error string includes String(err), which for non-SyntaxError throws could embed input-derived text. Recommend a size guard and sanitized error text."}

## Test gaps
- {"file":"packages/core/tests/diagnostics.test.ts","line":46,"summary":"No test for numeric severity input — would immediately expose the ESLint-style 1=warning→error misclassification above."}
- {"file":"packages/core/tests/diagnostics.test.ts","line":18,"summary":"Single-letter severity aliases in SEVERITY_MAP ('e', 'w', 'i', 'crit') are untested despite being public behavior."}
- {"file":"packages/core/tests/diagnostics.test.ts","line":88,"summary":"No test for the grouping-key collision (a message containing '|' merging distinct issues), which is the main correctness risk in summarizeDiagnostics."}
- {"file":"packages/core/tests/diagnostics.test.ts","line":60,"summary":"fixable and suggestion field mapping in toDiagnostic is untested; the TDD RED list mentions field mapping but these two fields are never asserted."}
- {"file":"packages/core/tests/diagnostics.test.ts","line":100,"summary":"No test for an empty diagnostic array (count 0, all bySeverity 0, truncated false, topIssues empty) and no test for negative/zero/non-integer topN."}
- {"file":"packages/core/tests/diagnostics.test.ts","line":60,"summary":"No test for toDiagnostic with a valid object whose message/rule fields are non-string (e.g. message: 42), which exercises the '(no message)' fallback inside an object."}

## Compatibility
- {"file":"packages/core/src/diagnostics/types.ts","line":96,"summary":"Numeric severity mapping is absent, which is the standard output shape for ESLint and several other linters' JSON formatters — a likely first integration target for this normalization layer. Either map numeric severities or reject them loudly rather than fail-safe to 'error'."}

## Architecture
- {"file":"packages/core/src/index.ts","line":10,"summary":"Module is pure, side-effect-free, and correctly re-exported from the core barrel; plugin/types.ts already imports these types, so this PR closes the dependency and lets the core package compile. No duplication of infra, consistent with the plugin standard. Recommend documenting the truncated-flag semantics in the ResultSummary doc comment."}
