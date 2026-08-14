# Review — reviewer-a (deepseek via claude cli)

- Verdict: **request_changes**
- Confidence: 0.82

## Blocking
- process-runner.test.ts ('kills grandchild processes on timeout'): the test does not validate what it claims and is timing-dependent. The first `runProcess` uses `timeoutMs: 0`, which schedules a ~1ms timer in the runner while the Node child needs ~10-40ms just to boot and then spawn the grandchild. Two outcomes: (a) the timer fires before `child.pid` is assigned, so `killTree` hits its `if (!child.pid) return` guard and does nothing — the parent survives, `await runProcess(...)` blocks ~60s until the parent's own 60s sleep ends, and the grandchild pid is then checked against the SECOND run's timeout, i.e. a grandchild whose lifecycle is unrelated to the kill under test (it dies naturally after 60s); or (b) the timer fires after pid is set, the parent is killed before it can spawn the grandchild, and `expect(existsSync(pidFile)).toBe(true)` fails after the 5s poll. In neither case is 'runner kills a grandchild on timeout' actually verified. The test must be rewritten to capture a live grandchild pid from a non-0-timeout run and assert that grandchild dies after a separate timed run.
- runner.ts runProcess: promise resolution is not bounded by an overall deadline. A child that spawns a descendant which detaches into its own process group/session (setsid, or a daemon double-fork) and inherits the stdout/stderr pipes is not killed by `process.kill(-pid, ...)` or `taskkill /T`; the pipes stay open, Node's 'close' event never fires, and the promise hangs indefinitely EVEN when `timeoutMs` is set. This fails the issue's explicitly-critical 'timeout enforcement' security consideration. Add an overall deadline (timeout + kill-grace + slack) that force-resolves, and/or set stdio so a descendant cannot hold the parent's capture pipes.

## Non-blocking
- JSON parsing is listed in the issue Objective but is not implemented anywhere in the PR (no parse helper, no JSON-mode option).
- maxOutputBytes is enforced in UTF-16 code units (string.length), not bytes as the docstring states; multi-byte UTF-8 output can exceed the advertised cap by up to ~3x.
- Child stdin defaults to a live pipe that is never closed; a CLI that reads stdin (e.g. cat, an interactive prompt) blocks forever when no timeout is set. Use stdio: ['ignore', 'pipe', 'pipe'].
- Explicit env entries are not automatically added to the redaction set; a plugin that passes DEEPSEEK_API_KEY via env leaks it in captured output unless it separately lists the value in `redact`.
- redactSecrets is order-sensitive for overlapping secrets: a shorter prefix listed before a longer secret leaves the remainder of the longer secret visible (e.g. ['abc','abc123'] vs ['abc123','abc']).
- On Windows, taskkill /T /F force-kills immediately, so the documented SIGTERM-then-SIGKILL grace contract is not honored, and the 1s escalation timer issues a redundant second taskkill against an already-dead pid.
- Spawn ENOENT/EACCES from a bad or inaccessible cwd is reported as BinaryNotFound, giving misleading diagnostics ('binary X: spawn cwd ... ENOENT').
- A stdio error after a successful spawn (e.g. EAGAIN) resolves the promise as an error via the `settled` guard, discarding the process's real exit code.
- timeoutMs: 0 means 'kill immediately' (undefined is the no-timeout sentinel) rather than the common '0 = disabled' convention; tests depend on this surprising behavior and negative values also kill immediately.

## Security
- Secret values passed via `env` are not auto-redacted from captured output; if the child echoes an env var, a caller who forgets to mirror it in `redact` leaks credentials. Consider auto-redacting Object.values(env) inside runProcess.
- killTree's negative-pid kill and Windows taskkill /T target a pid/process-group that may be recycled after the child exits, potentially signaling an unrelated process or group; the timeout+abort double-kill widens this window.
- A relative `binary` resolves through the allowlisted PATH; an attacker able to influence PATH or cwd can hijack execution. The docstring only 'recommends' absolute paths — the runner should enforce it or reject relative names.
- DEFAULT_ENV_ALLOWLIST passes HOME/USERPROFILE/APPDATA/LOCALAPPDATA to third-party CLIs by default; these directories often contain credentials/config that a (possibly compromised) CLI could read and exfiltrate.

## Test gaps
- No test that a timeout bounds promise resolution when a descendant escapes the process group and holds the capture pipes (the hang in blocking #2).
- No test that redaction applies to stderr.
- No test for stderr truncation.
- No test for an already-aborted AbortSignal passed into runProcess (the `signal.aborted` branch is untested).
- No Windows .cmd/.bat spawn test — argv fidelity through cmd.exe is unverified.
- No multi-byte/UTF-8 test exposing the byte-vs-code-unit cap mismatch.
- No test that a child reading stdin does not hang / that stdin is closed.
- No concurrency test (multiple runProcess calls in flight).
- The timeout tests only assert exitCode is null/non-zero; they never verify the process is actually terminated — the intended verification lives in the broken process-tree test.

## Compatibility
- On Windows, spawning .cmd/.bat shims routes argv through cmd.exe; %-expansion and cmd quoting can alter otherwise-verbatim arguments. The 'single argv entry with spaces/quotes' test uses the node .exe directly and misses this path.
- The allowlist omits LC_ALL/PYTHONIOENCODING; Python/Ruby/Perl toolchains on non-UTF-8 locales can emit locale-mangled output, making structured parsing unreliable.
- POSIX tree-kill assumes the child remains a session/group leader; a child that calls setsid itself escapes the kill — same unbounded-hang outcome as blocking #2.

## Architecture
- Issue Objective lists JSON parsing as in-scope for this runner; it is absent. Either implement it or formally move it to another issue.
- ExecutionError codes are only BinaryNotFound|SpawnFailure; adapters must translate timedOut/aborted into the ToolResult contract's Timeout/etc. codes, and that mapping contract is undocumented.
- Redaction should be wired from `env` values by construction inside runProcess so the security property holds without caller discipline.
- runProcess never rejects and embeds all failures in ExecutionResult — consistent with the contract, but there is no guard against a caller `await`-ing without checking `error`/`timedOut`.
