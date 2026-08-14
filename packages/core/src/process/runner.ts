/**
 * Core process runner (ISSUE-004, ADR-004).
 *
 * Executes a binary with typed argv[] — never through a shell. Provides
 * cwd, env allowlist, timeout, AbortSignal, output caps, and secret
 * redaction. The full inherited environment is NEVER passed to the child.
 */
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Grace period between SIGTERM and SIGKILL when terminating a process tree. */
const KILL_ESCALATION_MS = 1000;
/**
 * Additional slack after the SIGKILL escalation before the promise is
 * force-resolved. Guards against descendants that detach into their own
 * process group/session and keep the capture pipes open (which would
 * otherwise prevent the 'close' event from ever firing).
 */
const DEADLINE_SLACK_MS = 2000;
/**
 * After the process exits, stdio still needs to drain (the pipe buffer may
 * hold the tail of the output). We wait this long for the natural 'close'
 * event; only if it has not fired (a descendant holding the pipes) do we
 * force-destroy. This preserves output in the common case while bounding the
 * descendant-holds-pipes hang.
 */
const CLOSE_GRACE_MS = 3000;
/**
 * Auto-redaction only applies to env values at least this long. Short values
 * ("1", "0", "true", "read") are common substrings and must never be
 * globally replaced in captured output (that would corrupt the output).
 */
const MIN_SECRET_LENGTH = 8;
/**
 * Env keys whose values are treated as secrets for auto-redaction. Keyed by
 * name (not value) so common non-secret config values like NODE_ENV are never
 * rewritten, which would silently corrupt structured output.
 */
const SENSITIVE_ENV_KEY = /(token|secret|password|passwd|credential|authorization|api[_-]?key|deepseek)/i;

export interface ExecutionRequest {
  /** Binary to execute. Absolute path recommended; must not be a shell line. */
  binary: string;
  /** Typed arguments compiled to argv[]. Each entry is passed verbatim. */
  args: readonly string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Explicit environment entries added on top of the allowlisted set. */
  env?: Record<string, string>;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Cancel execution via AbortSignal. */
  signal?: AbortSignal;
  /** Per-stream output cap in bytes (default 1 MiB). Excess is dropped. */
  maxOutputBytes?: number;
  /** Secret values redacted from captured stdout/stderr. */
  redact?: readonly string[];
  /**
   * Whether env values under sensitive key names are auto-redacted from
   * captured output. Default true. Disable only when the caller explicitly
   * manages redaction.
   */
  autoRedact?: boolean;
}

export interface ExecutionError {
  code: "BinaryNotFound" | "SpawnFailure";
  message: string;
}

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
  error?: ExecutionError;
}

/**
 * Environment variables inherited by child processes. Keep minimal: only
 * what binaries need to launch and resolve their own dependencies.
 * Sensitive variables (credentials, tokens) must never appear here.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "TERM",
  "NO_COLOR",
];

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Build a child env from the allowlisted inherited vars plus explicit entries. */
export function buildEnv(
  allowlist: readonly string[],
  explicit?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) {
      env[key] = value;
    }
  }
  return env;
}

/** Replace every occurrence of each secret with [REDACTED]. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

interface CaptureState {
  data: string;
  truncated: boolean;
}

function attachCapture(
  stream: NodeJS.ReadableStream | null,
  cap: number,
  state: CaptureState,
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (state.data.length >= cap) {
      state.truncated = true;
      return;
    }
    if (state.data.length + chunk.length > cap) {
      state.data += chunk.slice(0, cap - state.data.length);
      state.truncated = true;
      return;
    }
    state.data += chunk;
  });
}

/**
 * Terminate a child AND its descendants. On POSIX the child is spawned in its
 * own process group (detached) so the whole group can be signalled; on
 * Windows taskkill /T walks the tree. A child that ignores the graceful
 * signal is escalated to SIGKILL after a grace period.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      // best-effort; 'close' on the child resolves the promise
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Execute a binary with typed argv[] — no shell, ever. */
export function runProcess(request: ExecutionRequest): Promise<ExecutionResult> {
  const {
    binary,
    args,
    cwd,
    env,
    timeoutMs,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    redact,
    autoRedact: autoRedactEnabled = true,
  } = request;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutState: CaptureState = { data: "", truncated: false };
    const stderrState: CaptureState = { data: "", truncated: false };

    let timedOut = false;
    let aborted = false;
    let settled = false;

    // Env values under sensitive key names are secrets by construction: if the
    // child echoes them back, the captured output must not leak them even when
    // the caller forgets to list them in `redact`. Only long-enough values
    // under sensitive key names are auto-redacted so common config values
    // (NODE_ENV, FORCE_COLOR, ...) never corrupt legitimate output.
    const autoRedact: string[] = [];
    if (autoRedactEnabled) {
      if (env) {
        for (const [key, value] of Object.entries(env)) {
          if (
            SENSITIVE_ENV_KEY.test(key) &&
            typeof value === "string" &&
            value.length >= MIN_SECRET_LENGTH
          ) {
            autoRedact.push(value);
          }
        }
      }
    }
    const redactList = [...autoRedact, ...(redact ?? [])];

    let child: ChildProcess;
    try {
      child = spawn(binary, [...args], {
        shell: false,
        cwd,
        env: buildEnv(DEFAULT_ENV_ALLOWLIST, env),
        windowsHide: true,
        // stdin is ignored/closed so a child reading stdin cannot hang the
        // harness; stdout/stderr are piped for capture.
        stdio: ["ignore", "pipe", "pipe"],
        // Detached on POSIX creates a process group so the whole tree can be
        // terminated on timeout/abort; on Windows taskkill /T handles it.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: String(err),
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: Date.now() - startedAt,
        error: { code: "SpawnFailure", message: String(err) },
      });
      return;
    }

    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, error?: ExecutionError) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (closeGraceTimer !== undefined) clearTimeout(closeGraceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const apply = (state: CaptureState): string =>
        redactList.length > 0 ? redactSecrets(state.data, redactList) : state.data;
      resolve({
        exitCode,
        stdout: apply(stdoutState),
        stderr: apply(stderrState),
        timedOut,
        aborted,
        truncated: stdoutState.truncated || stderrState.truncated,
        durationMs: Date.now() - startedAt,
        error,
      });
    };

    /**
     * Graceful kill of the tree, escalating to SIGKILL after the grace
     * period, and force-resolving via an overall deadline afterwards. The
     * deadline guarantees the promise never hangs: a descendant that detaches
     * into its own process group/session can keep the capture pipes open and
     * prevent 'close' from firing, so we resolve on a hard timer.
     */
    function terminateTree(): void {
      killTree(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        killTree(child, "SIGKILL");
      }, KILL_ESCALATION_MS);
      if (deadlineTimer === undefined) {
        deadlineTimer = setTimeout(() => {
          finish(null);
        }, KILL_ESCALATION_MS + DEADLINE_SLACK_MS);
      }
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateTree();
      }, timeoutMs);
    }

    function onAbort(): void {
      aborted = true;
      terminateTree();
    }
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        terminateTree();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    attachCapture(child.stdout, maxOutputBytes, stdoutState);
    attachCapture(child.stderr, maxOutputBytes, stderrState);

    child.on("error", (err: NodeJS.ErrnoException) => {
      const code =
        err.code === "ENOENT" || err.code === "EACCES"
          ? "BinaryNotFound"
          : "SpawnFailure";
      finish(null, { code, message: `binary '${binary}': ${err.message}` });
    });

    // Do NOT destroy the capture streams immediately on 'exit': 'exit' fires
    // before stdio has fully drained, and the pipe buffer may still hold the
    // tail of the output. Instead, start a grace timer; only if 'close' has
    // not fired within the grace period (a descendant holding the pipes) do
    // we force-destroy, so the descendant-holds-pipes hang is bounded without
    // losing output in the common case.
    child.on("exit", () => {
      if (closeGraceTimer === undefined) {
        closeGraceTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, CLOSE_GRACE_MS);
      }
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
