# Review — reviewer-a (deepseek via claude cli)

- Verdict: **approve**
- Confidence: 0.8

## Blocking
(none)

## Non-blocking
- maxOutputBytes is enforced in UTF-16 code units (string.length), not bytes as the docstring and the issue's 'output truncation' consideration claim; multi-byte UTF-8 output can exceed the advertised cap by up to ~3x, and chunk.slice() at a code-unit boundary can split a multi-byte character into a lone replacement char at the truncation point.
- timeoutMs: 0 (and any negative value) means 'kill immediately' because the only sentinel is undefined; a caller following the common '0 = disabled' convention gets an instant kill. No test exercises 0, and the semantics are undocumented.
- redactSecrets is order-sensitive for overlapping secrets: a shorter prefix processed before a longer secret leaves the longer secret's tail visible (['abc','abc123'] vs ['abc123','abc']), which can leak a credential that shares a prefix with another redaction entry.
- Redaction runs after truncation on the final captured string; a secret that straddles the truncation boundary is not matched and its captured prefix is returned unredacted (only matters for secrets near/over the output cap).
- finish() early-returns once settled without clearing timers; in the deadline path a subsequent 'exit' event can start a 3s close-grace timer that is never cleared (harmless event-loop hold, but a timer/fd-handle leak in long-lived hosts).
- On Windows, taskkill /T /F force-kills immediately, so the documented SIGTERM-then-SIGKILL grace contract is not honored, and the 1s escalation timer issues a redundant second taskkill against an already-dead pid (the exitCode guard narrows but does not eliminate the race).
- If taskkill itself is missing or fails, the kill silently no-ops and only the deadline resolves the promise; the child process leaks until the deadline.
- A bad or inaccessible cwd surfaces as `spawn cwd ... ENOENT` and is mislabeled BinaryNotFound, which misleads diagnostics when the binary is actually present.

## Security
- binary is only 'recommended' to be absolute; a relative name resolves through the allowlisted PATH, which is inherited from the harness process. An attacker able to influence PATH or cwd can hijack execution of what callers believe is a pinned tool.
- The child's stdout/stderr capture streams have no 'error' listeners. An I/O error on a capture pipe raises an unhandled 'error' event and crashes the entire host process, not just the runner — a single bad read takes down the harness.
- DEFAULT_ENV_ALLOWLIST passes HOME/USERPROFILE/APPDATA/LOCALAPPDATA to every third-party CLI by default; these directories commonly hold credentials/config, so a compromised or hostile CLI can read and exfiltrate them. The allowlist is the one security boundary here and should be trimmed.
- The POSIX killTree liveness check (kill(-pid, 0)) cannot distinguish the original process group from a recycled pgid; in the 1s SIGTERM->SIGKILL window a dead group's pgid could be reassigned and the SIGKILL escalation would signal an unrelated group. Mitigated, not eliminated.
- Auto-redaction's SENSITIVE_ENV_KEY regex matches any key containing 'deepseek', so DEEPSEEK_BASE_URL (a non-secret config URL) is auto-redacted from output; if a CLI legitimately echoes the base URL, structured output is silently corrupted. Over-redaction is safe-but-lossy and the opt-out is easy to forget.

## Test gaps
- No test that redaction applies to stderr.
- No test for stderr truncation (truncated flag only exercised on stdout).
- No test for an already-aborted AbortSignal passed into runProcess (the signal.aborted synchronous branch is untested).
- No Windows .cmd/.bat spawn test — the 'single argv entry with spaces/quotes' test uses node.exe directly and never exercises cmd.exe shim argv quoting.
- No multi-byte/UTF-8 test exposing the byte-vs-code-unit cap mismatch.
- No concurrency test (multiple runProcess calls in flight sharing the module-level regex/allowlist).
- No test for the false-timeout edge: a child that exits before the timeout while a detached descendant holds the pipes is reported timedOut=true even though it finished normally.
- The timeout tests assert exitCode null/non-zero but only the detached-descendant test (loose <15000ms) verifies the promise is bounded within the documented grace+slack window.

## Compatibility
- On Windows, spawning .cmd/.bat shims routes argv through cmd.exe; %-expansion and cmd quoting can alter otherwise-verbatim arguments, and this path is unverified by tests.
- The allowlist omits LC_ALL and PYTHONIOENCODING; on non-UTF-8 locales, Python/Ruby/Perl toolchains can emit locale-mangled output (LANG alone is not honored the same way on Windows), making structured parsing unreliable.
- POSIX tree-kill assumes the child remains the process-group leader; a child that calls setsid() or double-forks escapes the kill, and the deadline only bounds the promise — the escaped process leaks until it exits naturally.

## Architecture
- JSON parsing listed in the issue Objective is not implemented anywhere (no parse helper, no JSON mode option); either implement it or formally move it to another issue, since the acceptance criteria and ToolResult contract depend on structured output.
- ExecutionError codes are only BinaryNotFound|SpawnFailure; adapters must translate timedOut/aborted into the ToolResult contract's Timeout/etc. codes, and that mapping contract is undocumented.
- runProcess never rejects and embeds all failures in ExecutionResult, but there is no guard or documentation warning for a caller that awaits without checking error/timedOut/truncated.
- Auto-redaction is disconnected from the explicit redact list: a short token (< MIN_SECRET_LENGTH) under a sensitive key leaks unless the caller also lists it, and the interplay between auto-redaction, MIN_SECRET_LENGTH, and redact is undocumented.
