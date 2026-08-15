import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/** True when the resolved binary path exists on disk. */
export function binaryAvailable(binaryPath: string): boolean {
  try {
    return statSync(binaryPath).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a daemon (e.g. `docker version`) is reachable. Runs the command
 * synchronously WITHOUT a shell (allowed by ADR-004's eslint rule — only
 * `shell: true` / exec are flagged), bounded to 5s.
 */
export function daemonAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Poll an HTTP URL until it responds 2xx, up to `timeoutMs`. */
export async function waitForHttp(
  url: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url}`);
}
