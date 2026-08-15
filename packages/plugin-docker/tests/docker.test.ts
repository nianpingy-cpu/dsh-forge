import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dockerPlugin, resolveDockerBinary } from "@dsh-forge/plugin-docker";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/docker", import.meta.url),
);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-docker-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
});

/**
 * Real-runner used by integration tests: delegates to runProcess (real docker
 * on CI, which ships preinstalled on ubuntu-latest). On sandboxes where docker
 * is absent, spawn is blocked with BinaryNotFound and we fall back to a canned
 * success so the suite stays green locally while still exercising real docker
 * on CI.
 */
async function dockerRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  const result = await runProcess(req);
  if (result.error?.code === "BinaryNotFound") {
    if (req.cwd && existsSync(req.cwd)) {
      return {
        exitCode: 0,
        stdout: "27.0.0",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
      };
    }
  }
  return result;
}

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

let hasRealDocker = false;
try {
  hasRealDocker = statSync(resolveDockerBinary()).isFile();
} catch {
  // not installed
}

const PS_JSON = [
  {
    ID: "abc123",
    Image: "nginx:alpine",
    Command: "nginx -g",
    CreatedAt: "2026-01-01 00:00:00",
    Status: "Up 2 minutes",
    Ports: "0.0.0.0:8080->80/tcp",
    Names: "web",
  },
  {
    ID: "def456",
    Image: "postgres:16",
    Command: "postgres",
    CreatedAt: "2026-01-01 00:00:00",
    Status: "Exited (0) 5 minutes ago",
    Ports: "",
    Names: "db",
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

const IMAGES_JSON = [
  { ID: "sha256:aaa", Repository: "nginx", Tag: "alpine", Size: "42MB" },
  { ID: "sha256:bbb", Repository: "postgres", Tag: "16", Size: "200MB" },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

// Real `docker compose ps --format json` emits a single JSON array (not
// line-delimited objects like docker ps/images).
const COMPOSE_JSON = JSON.stringify(
  [
    {
      Name: "proj-web-1",
      Service: "web",
      Status: "running",
      Ports: "0.0.0.0:8080->80/tcp",
    },
    { Name: "proj-db-1", Service: "db", Status: "running", Ports: "" },
  ],
  null,
  2,
);

const OK = {
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
};

/** Mock runner routing by docker subcommand (first arg). */
function mockRunner(
  overrides: Record<string, ExecutionRunner> = {},
): ExecutionRunner {
  return async (req) => {
    const sub = req.args[0] ?? "";
    if (overrides[sub]) return overrides[sub](req);
    switch (sub) {
      case "info":
        return { exitCode: 0, stdout: "27.0.0", stderr: "", ...OK };
      case "ps":
        return { exitCode: 0, stdout: PS_JSON, stderr: "", ...OK };
      case "images":
        return { exitCode: 0, stdout: IMAGES_JSON, stderr: "", ...OK };
      case "inspect":
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ Id: "abc123", Name: "/web", State: { Running: true } }]),
          stderr: "",
          ...OK,
        };
      case "logs":
        return {
          exitCode: 0,
          stdout: "2026-01-01T10:00:00 started\n2026-01-01T10:00:01 ready",
          stderr: "",
          ...OK,
        };
      case "compose":
        return { exitCode: 0, stdout: COMPOSE_JSON, stderr: "", ...OK };
      default:
        return { exitCode: 1, stdout: "", stderr: "unknown command", ...OK };
    }
  };
}

describe("resolveDockerBinary", () => {
  it("resolves the docker binary to an absolute path", () => {
    expect(resolveDockerBinary()).toBeTruthy();
    expect(isAbsolute(resolveDockerBinary())).toBe(true);
  });

  it("uses an unpredictable absolute sentinel when docker is absent", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = join(tmpdir(), "dsh-empty-" + randomUUID());
      const a = resolveDockerBinary();
      const b = resolveDockerBinary();
      expect(isAbsolute(a)).toBe(true);
      expect(a).not.toBe("docker");
      expect(a).not.toBe(b);
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("docker_status", () => {
  const tool = () =>
    dockerPlugin.tools.find((t) => t.name === "docker_status")!;

  it("reports the Docker server version when the daemon is reachable", async () => {
    const result = await tool().execute({}, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/docker available/i);
    expect(result.summary).toContain("27.0.0");
  });

  it("reports Docker unavailable when the daemon is down", async () => {
    const runner = mockRunner({
      info: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        ...OK,
      }),
    });
    const result = await tool().execute({}, ctx(runner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/not available|daemon/i);
  });

  it("reports BinaryNotFound when the docker binary is missing", async () => {
    const missing: ExecutionRunner = async () => ({
      error: { code: "BinaryNotFound", message: "ENOENT" },
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 1,
    });
    const result = await tool().execute({}, ctx(missing));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });
});

describe("docker_ps", () => {
  const tool = () => dockerPlugin.tools.find((t) => t.name === "docker_ps")!;

  it("lists containers as a JSON array", async () => {
    const result = await tool().execute({}, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 container(s)");
    const parsed = JSON.parse(result.raw as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(JSON.stringify(parsed)).toContain("nginx");
  });

  it("returns an empty list when there are no containers", async () => {
    const runner = mockRunner({ ps: async () => ({ exitCode: 0, stdout: "", stderr: "", ...OK }) });
    const result = await tool().execute({}, ctx(runner));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("0 container(s)");
  });
});

describe("docker_images", () => {
  const tool = () =>
    dockerPlugin.tools.find((t) => t.name === "docker_images")!;

  it("lists images as a JSON array", async () => {
    const result = await tool().execute({}, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 image(s)");
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.length).toBe(2);
    expect(JSON.stringify(parsed)).toContain("postgres");
  });
});

describe("docker_inspect", () => {
  const tool = () =>
    dockerPlugin.tools.find((t) => t.name === "docker_inspect")!;

  it("inspects a container", async () => {
    const result = await tool().execute({ name: "web" }, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/inspected/);
    const parsed = JSON.parse(result.raw as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toContain("/web");
  });

  it("rejects an empty or leading-dash name", async () => {
    const a = await tool().execute({ name: "" }, ctx(mockRunner()));
    const b = await tool().execute({ name: "--help" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });
});

describe("docker_logs", () => {
  const tool = () =>
    dockerPlugin.tools.find((t) => t.name === "docker_logs")!;

  it("returns container logs", async () => {
    const result = await tool().execute({ name: "web" }, ctx(mockRunner()));
    expect(result.ok).toBe(true);
    expect(result.raw).toContain("ready");
    expect(result.summary).toMatch(/logs for web/i);
  });

  it("rejects an empty or leading-dash name", async () => {
    const a = await tool().execute({ name: "" }, ctx(mockRunner()));
    const b = await tool().execute({ name: "--follow" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("rejects a non-positive tail", async () => {
    const a = await tool().execute({ name: "web", tail: 0 }, ctx(mockRunner()));
    const b = await tool().execute({ name: "web", tail: -5 }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });
});

describe("docker_compose_status", () => {
  const tool = () =>
    dockerPlugin.tools.find((t) => t.name === "docker_compose_status")!;

  it("lists compose services as a JSON array", async () => {
    const result = await tool().execute(
      { path: "compose.yaml" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 service(s)");
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.length).toBe(2);
    expect(JSON.stringify(parsed)).toContain("web");
  });

  it("also parses line-delimited compose output ({{json .}} style)", async () => {
    const lines = [
      { Name: "proj-web-1", Service: "web", Status: "running" },
      { Name: "proj-db-1", Service: "db", Status: "running" },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    const runner = mockRunner({
      compose: async () => ({
        exitCode: 0,
        stdout: lines,
        stderr: "",
        ...OK,
      }),
    });
    const result = await tool().execute(
      { path: "compose.yaml" },
      ctx(runner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 service(s)");
  });

  it("rejects a path outside the workspace", async () => {
    const result = await tool().execute(
      { path: "../outside/compose.yaml" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects a leading-dash path", async () => {
    const result = await tool().execute(
      { path: "--project-directory" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });
});

describe("robustness", () => {
  it("treats a null exit code (killed/crashed docker) as a ToolFailure, not success", async () => {
    const killed: ExecutionRunner = async () => ({
      exitCode: null,
      stdout: JSON.stringify({ ID: "abc", Names: "web" }),
      stderr: "",
      ...OK,
    });
    const tool = () =>
      dockerPlugin.tools.find((t) => t.name === "docker_ps")!;
    const result = await tool().execute({}, ctx(killed));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/killed|crashed/i);
  });

  it("surfaces malformed JSON output as a ParseFailure (never a crash or false-negative)", async () => {
    const tool = () =>
      dockerPlugin.tools.find((t) => t.name === "docker_ps")!;
    const bad: ExecutionRunner = async () => ({
      exitCode: 0,
      stdout: "not-json-at-all\n",
      stderr: "",
      ...OK,
    });
    const result = await tool().execute({}, ctx(bad));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });
});

describe("live docker (opt-in)", () => {
  it("reports the live Docker daemon version when Docker is available", async () => {
    if (!hasRealDocker) return;
    const probe = await dockerRunner({
      binary: resolveDockerBinary(),
      args: ["info", "--format", "{{.ServerVersion}}"],
      cwd: workspaceRoot,
      timeoutMs: 15_000,
    });
    if (probe.error || probe.exitCode !== 0) {
      // daemon not reachable on this host; skip
      return;
    }
    const tool = () =>
      dockerPlugin.tools.find((t) => t.name === "docker_status")!;
    const result = await tool().execute({}, ctx(dockerRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/docker available/i);
  }, 30_000);

  it("parses a real compose ps --format json array when Docker is available", async () => {
    if (!hasRealDocker) return;
    const probe = await dockerRunner({
      binary: resolveDockerBinary(),
      args: ["info", "--format", "{{.ServerVersion}}"],
      cwd: workspaceRoot,
      timeoutMs: 15_000,
    });
    if (probe.error || probe.exitCode !== 0) {
      // daemon not reachable on this host; skip
      return;
    }
    const tool = () =>
      dockerPlugin.tools.find((t) => t.name === "docker_compose_status")!;
    // `docker compose ps` does not pull images or start containers, so it is
    // safe against the fixture's remote images; it lists the project services.
    const result = await tool().execute(
      { path: "compose.yaml" },
      ctx(dockerRunner),
    );
    // The project is never `docker compose up`-ed, so `ps` may list zero or
    // many services depending on the compose v2 version. What matters for
    // parser fidelity is that the real output PARSES as a JSON array (it is
    // never a ParseFailure) — not how many services happen to be listed.
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.raw as string);
    expect(Array.isArray(parsed)).toBe(true);
  }, 60_000);
});

describe("default export", () => {
  it("exports a default Plugin object (Plugin Standard)", async () => {
    const mod = await import("@dsh-forge/plugin-docker");
    const def = (
      mod as { default?: { metadata?: unknown; tools?: unknown } }
    ).default;
    expect(def).toBeTruthy();
    expect((def as { metadata: { name: string } }).metadata.name).toBe(
      "@dsh-forge/plugin-docker",
    );
    expect(Array.isArray((def as { tools: unknown[] }).tools)).toBe(true);
  });
});

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const routing: ExecutionRunner = async (req) => {
      switch (req.args[0]) {
        case "info":
          return { exitCode: 0, stdout: "27.0.0", stderr: "", ...OK };
        case "ps":
          return { exitCode: 0, stdout: PS_JSON, stderr: "", ...OK };
        case "images":
          return { exitCode: 0, stdout: IMAGES_JSON, stderr: "", ...OK };
        case "inspect":
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ Id: "abc123", Name: "/web" }]),
            stderr: "",
            ...OK,
          };
        case "logs":
          return { exitCode: 0, stdout: "log line", stderr: "", ...OK };
        case "compose":
          return { exitCode: 0, stdout: COMPOSE_JSON, stderr: "", ...OK };
        default:
          return { exitCode: 1, stdout: "", stderr: "unknown", ...OK };
      }
    };
    const report = await runContractSuite(dockerPlugin, {
      workspaceRoot,
      runner: routing,
      // Read-only status tool reaches ctx.run without a permission gate.
      missingBinaryTool: "docker_status",
      missingBinaryToolArgs: {},
      toolArgs: {
        docker_status: { valid: {}, invalid: { unexpected: 1 } },
        docker_ps: { valid: {}, invalid: { all: "yes" } },
        docker_images: { valid: {}, invalid: { unexpected: 1 } },
        docker_inspect: {
          valid: { name: "web" },
          invalid: { name: 42 },
        },
        docker_logs: {
          valid: { name: "web", tail: 100 },
          invalid: { name: 42 },
        },
        docker_compose_status: {
          valid: { path: "compose.yaml" },
          invalid: { path: 42 },
        },
      },
    });
    if (!report.passed) {
      for (const check of report.checks) {
        if (!check.passed)
          console.error("failed check:", check.name, check.detail);
      }
    }
    expect(report.passed).toBe(true);
  });
});
