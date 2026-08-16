import { describe, expect, it, beforeAll } from "vitest";
import {
  mkdtempSync,
  cpSync,
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { visionPlugin, resolveVisionWorker } from "@dsh-forge/plugin-vision";
import {
  runContractSuite,
  runProcess,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunner,
  type ToolContext,
} from "@dsh-forge/core";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/vision", import.meta.url),
);

let workspaceRoot: string;

// ------------------------------------------------------------- fixtures ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Deterministic non-interlaced 8-bit RGB PNG (filter 0 rows). */
function makePng(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number],
): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const p = y * (width * 3 + 1) + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-vision-"));
  cpSync(FIXTURES, workspaceRoot, { recursive: true });
  // A gradient screenshot (non-trivial contrast, normal aspect ratio).
  writeFileSync(
    join(workspaceRoot, "sample.png"),
    makePng(320, 200, (x, y) => [(x * 2) % 256, (y * 3) % 256, 180]),
  );
  // A tiny flat gray image (tiny-image + low-contrast heuristics).
  writeFileSync(
    join(workspaceRoot, "flat.png"),
    makePng(64, 64, () => [128, 128, 128]),
  );
  writeFileSync(
    join(workspaceRoot, "not-image.txt"),
    "hello, not an image",
    "utf8",
  );
});

// ------------------------------------------------------------- runners ---

function realRunner(req: ExecutionRequest): Promise<ExecutionResult> {
  return runProcess(req);
}

const ctx = (runner: ExecutionRunner, approved = true): ToolContext => ({
  workspaceRoot,
  run: runner,
  permission: approved ? { approved: true } : undefined,
});

const OK = {
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
};

function mockRunner(): ExecutionRunner {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
    ...OK,
  });
}

function captureRunner(
  onCapture: (req: ExecutionRequest) => void,
  overrides: Partial<ExecutionResult> = {},
): ExecutionRunner {
  return async (req) => {
    onCapture(req);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      ...OK,
      ...overrides,
    };
  };
}

function missingRunner(): ExecutionRunner {
  return async () => ({
    error: { code: "BinaryNotFound", message: "ENOENT" },
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 1,
  });
}

function malformedRunner(): ExecutionRunner {
  return async () => ({
    exitCode: 0,
    stdout: "{ not json",
    stderr: "",
    ...OK,
  });
}

// ------------------------------------------------------------- resolve ---

describe("resolve worker", () => {
  it("resolves the vision worker to an existing absolute path", () => {
    const worker = resolveVisionWorker();
    expect(isAbsolute(worker)).toBe(true);
    expect(existsSync(worker)).toBe(true);
  });

  it("returns an absolute sentinel when the worker is absent (never a bare name)", () => {
    const worker = resolveVisionWorker();
    expect(worker).not.toBe("vision-worker.mjs");
    expect(worker).not.toBe("node");
  });
});

// ------------------------------------------------------- vision_inspect ---

describe("vision_inspect (read)", () => {
  const tool = () =>
    visionPlugin.tools.find((t) => t.name === "vision_inspect")!;

  it("inspects a PNG and reports dimensions + color heuristics", async () => {
    const result = await tool().execute(
      { input: "sample.png" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("png");
    expect(result.summary).toContain("320x200");
    expect(result.raw).toContain("meanLuminance");
    expect(result.raw).toContain("luminanceStddev");
  });

  it("emits warning diagnostics for a tiny low-contrast image", async () => {
    const result = await tool().execute({ input: "flat.png" }, ctx(realRunner));
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.some((d) => d.rule === "tiny-image")).toBe(true);
    expect(result.diagnostics?.some((d) => d.rule === "low-contrast")).toBe(
      true,
    );
    expect(result.summaryBlock?.bySeverity.warning ?? 0).toBeGreaterThan(0);
  });

  it("rejects a non-image file as a ToolFailure", async () => {
    const result = await tool().execute(
      { input: "not-image.txt" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
    expect(result.error?.message).toMatch(/format/i);
  });

  it("rejects an input outside the workspace", async () => {
    const result = await tool().execute(
      { input: "../outside/img.png" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an empty or leading-dash input", async () => {
    const a = await tool().execute({ input: "" }, ctx(mockRunner()));
    const b = await tool().execute({ input: "--task" }, ctx(mockRunner()));
    const c = await tool().execute({ input: "a\rb.png" }, ctx(mockRunner()));
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
    expect(c.error?.code).toBe("InvalidArguments");
  });

  it("reports BinaryNotFound when the worker is missing", async () => {
    const result = await tool().execute(
      { input: "sample.png" },
      ctx(missingRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("surfaces malformed worker output as a ParseFailure", async () => {
    const result = await tool().execute(
      { input: "sample.png" },
      ctx(malformedRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ParseFailure");
  });

  it("blocks reads through a symlink escaping the workspace", async () => {
    const target = join(workspaceRoot, "..", "secret.png");
    writeFileSync(target, "x", "utf8");
    const linkPath = join(workspaceRoot, "escape-in.png");
    try {
      symlinkSync(target, linkPath, "file");
    } catch {
      return; // symlinks unavailable; skip
    }
    const result = await tool().execute(
      { input: "escape-in.png" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects an oversize task string (argv cap)", async () => {
    const result = await tool().execute(
      { input: "sample.png", task: "x".repeat(2001) },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("passes a task through and reports the backend-unavailable diagnostic", async () => {
    const result = await tool().execute(
      { input: "sample.png", task: "review the header layout" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics?.some((d) => d.rule === "backend-unavailable"),
    ).toBe(true);
  }, 30_000);
});

// -------------------------------------------------------- data_analyze ---

describe("data_analyze (read)", () => {
  const tool = () => visionPlugin.tools.find((t) => t.name === "data_analyze")!;

  it("analyzes a CSV and reports row/column counts and statistics", async () => {
    const result = await tool().execute({ data: "sales.csv" }, ctx(realRunner));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("csv");
    expect(result.summary).toContain("6 row(s) x 4 column(s)");
    expect(result.raw).toContain("sales");
    expect(result.raw).toContain("mean");
  });

  it("analyzes a JSON array of objects", async () => {
    const result = await tool().execute(
      { data: "users.json" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("json");
    expect(result.summary).toContain("3 row(s)");
  });

  it("fails cleanly for a missing data file", async () => {
    const result = await tool().execute({ data: "nope.csv" }, ctx(realRunner));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ToolFailure");
  });

  it("rejects a data file outside the workspace", async () => {
    const result = await tool().execute(
      { data: "../outside/data.csv" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects non-string data arguments", async () => {
    const result = await tool().execute({ data: 42 }, ctx(mockRunner()));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("reports BinaryNotFound when the worker is missing", async () => {
    const result = await tool().execute(
      { data: "sales.csv" },
      ctx(missingRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("handles very large datasets without stack overflow", async () => {
    const lines = ["value"];
    for (let i = 0; i < 300_000; i++) lines.push(String(i));
    writeFileSync(join(workspaceRoot, "large.csv"), lines.join("\n"), "utf8");
    const result = await tool().execute({ data: "large.csv" }, ctx(realRunner));
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"rows": 300000');
    expect(result.raw).toContain('"max": 299999');
  }, 60_000);

  it("excludes non-numeric cells from mixed-column statistics", async () => {
    // The value column is >80% numeric (typed "number") but contains one
    // non-numeric cell that must not coerce to 0 in min/mean/sum.
    writeFileSync(
      join(workspaceRoot, "mixed.csv"),
      "name,value\nA,10\nB,20\nC,30\nD,40\nE,50\nF,n/a",
      "utf8",
    );
    const result = await tool().execute({ data: "mixed.csv" }, ctx(realRunner));
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"min": 10');
    expect(result.raw).toContain('"max": 50');
    expect(result.raw).toContain('"mean": 30');
    expect(result.raw).toContain('"sum": 150');
    expect(result.raw).toContain('"count": 5');
  }, 30_000);

  it("strips a UTF-8 BOM from the first CSV column name", async () => {
    writeFileSync(
      join(workspaceRoot, "bom.csv"),
      "\uFEFFmonth,sales\nJan,10\nFeb,20",
      "utf8",
    );
    const result = await tool().execute({ data: "bom.csv" }, ctx(realRunner));
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"name": "month"');
    expect(result.raw).not.toContain("\\ufeff");
  }, 30_000);
});

// ------------------------------------------------------ chart_generate ---

describe("chart_generate (workspace-write)", () => {
  const tool = () =>
    visionPlugin.tools.find((t) => t.name === "chart_generate")!;

  const series = [
    { label: "Jan", value: 10 },
    { label: "Feb", value: 20 },
    { label: "Mar", value: 15 },
  ];

  it("denies without permission approval (workspace-write)", async () => {
    const result = await tool().execute(
      { series, type: "bar", output: "deny.svg" },
      ctx(mockRunner(), false),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PermissionDenied");
  });

  it("writes an SVG chart from an inline series", async () => {
    const result = await tool().execute(
      { series, type: "bar", title: "Sales", output: "series.svg" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("bar");
    expect(result.summary).toContain("3 point(s)");
    const svg = readFileSync(join(workspaceRoot, "series.svg"), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("Sales");
  });

  it("writes an SVG chart from a data file", async () => {
    const result = await tool().execute(
      { data: "sales.csv", type: "line", output: "line.svg" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(workspaceRoot, "line.svg"))).toBe(true);
  });

  it("supports pie, area and scatter types", async () => {
    for (const type of ["pie", "area", "scatter"] as const) {
      const out = `${type}.svg`;
      const result = await tool().execute(
        { series, type, output: out },
        ctx(realRunner),
      );
      expect(
        result.ok,
        `${type}: ${result.error?.message ?? result.summary}`,
      ).toBe(true);
      expect(existsSync(join(workspaceRoot, out))).toBe(true);
    }
  });

  it("refuses to overwrite an existing output without overwrite=true", async () => {
    writeFileSync(join(workspaceRoot, "existing.svg"), "x", "utf8");
    const result = await tool().execute(
      { series, type: "bar", output: "existing.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/exists|overwrite/i);
  });

  it("overwrites when overwrite=true", async () => {
    writeFileSync(join(workspaceRoot, "existing.svg"), "x", "utf8");
    const result = await tool().execute(
      { series, type: "bar", output: "existing.svg", overwrite: true },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an output outside the workspace", async () => {
    const result = await tool().execute(
      { series, type: "bar", output: "../outside/out.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WorkspaceViolation");
  });

  it("rejects a leading-dash output (flag injection)", async () => {
    const result = await tool().execute(
      { series, type: "bar", output: "--out" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("requires either a data file or a series", async () => {
    const result = await tool().execute(
      { type: "bar", output: "o.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects an unknown chart type", async () => {
    const result = await tool().execute(
      { series, type: "bogus", output: "o.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects out-of-range dimensions", async () => {
    const a = await tool().execute(
      { series, type: "bar", width: 10, output: "o.svg" },
      ctx(mockRunner()),
    );
    const b = await tool().execute(
      { series, type: "bar", height: 99999, output: "o.svg" },
      ctx(mockRunner()),
    );
    expect(a.error?.code).toBe("InvalidArguments");
    expect(b.error?.code).toBe("InvalidArguments");
  });

  it("passes typed argv to the worker (--type, --out, --series), no shell", async () => {
    let captured: ExecutionRequest | undefined;
    const result = await tool().execute(
      { series, type: "bar", output: "capture.svg" },
      ctx(captureRunner((req) => (captured = req))),
    );
    expect(result.ok).toBe(true);
    expect(captured!.binary).toBe(process.execPath);
    const args = captured!.args as string[];
    expect(args[0]).toBe(resolveVisionWorker());
    expect(args[1]).toBe("chart");
    expect(args).toContain("--type");
    expect(args).toContain("bar");
    expect(args).toContain("--out");
    expect(args.some((a) => a.endsWith("capture.svg"))).toBe(true);
    expect(args.some((a) => a.includes('"label"'))).toBe(true); // series JSON
    expect(args).not.toContain("--overwrite");
  });

  it("reports BinaryNotFound when the worker is missing", async () => {
    const result = await tool().execute(
      { series, type: "bar", output: "o.svg" },
      ctx(missingRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BinaryNotFound");
  });

  it("renders negative bar values inside the plot area", async () => {
    const result = await tool().execute(
      {
        series: [
          { label: "A", value: 10 },
          { label: "B", value: -5 },
        ],
        type: "bar",
        output: "neg.svg",
      },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    const svg = readFileSync(join(workspaceRoot, "neg.svg"), "utf8");
    expect(svg).toContain("<rect");
  }, 30_000);

  it("rejects a series larger than 2000 points", async () => {
    const big = Array.from({ length: 2001 }, (_, i) => ({
      label: `L${i}`,
      value: i,
    }));
    const result = await tool().execute(
      { series: big, type: "bar", output: "big.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("rejects an oversize title (argv cap)", async () => {
    const result = await tool().execute(
      { series, type: "bar", title: "x".repeat(2001), output: "t.svg" },
      ctx(mockRunner()),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("InvalidArguments");
  });

  it("creates missing parent directories for nested outputs", async () => {
    const result = await tool().execute(
      { series, type: "bar", output: "charts/sales.svg" },
      ctx(realRunner),
    );
    expect(result.ok, result.error?.message ?? result.summary).toBe(true);
    expect(existsSync(join(workspaceRoot, "charts", "sales.svg"))).toBe(true);
  }, 30_000);

  it("renders a single-point pie as a full circle", async () => {
    const result = await tool().execute(
      {
        series: [{ label: "Only", value: 42 }],
        type: "pie",
        output: "one.svg",
      },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    const svg = readFileSync(join(workspaceRoot, "one.svg"), "utf8");
    expect(svg).toContain("<circle");
  }, 30_000);
});

// ------------------------------------------------- live worker (always) ---

describe("live worker (committed script, always available)", () => {
  it("inspects a real PNG through the process runner", async () => {
    const inspect = visionPlugin.tools.find(
      (t) => t.name === "vision_inspect",
    )!;
    const result = await inspect.execute(
      { input: "sample.png" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"format": "png"');
  }, 30_000);

  it("analyzes the fixture CSV through the process runner", async () => {
    const analyze = visionPlugin.tools.find((t) => t.name === "data_analyze")!;
    const result = await analyze.execute(
      { data: "sales.csv" },
      ctx(realRunner),
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"columns": 4');
  }, 30_000);
});

// --------------------------------------------------------- default export ---

describe("default export", () => {
  it("exports a default Plugin object (Plugin Standard)", async () => {
    const mod = await import("@dsh-forge/plugin-vision");
    const def = (mod as { default?: { metadata?: unknown; tools?: unknown } })
      .default;
    expect(def).toBeTruthy();
    expect((def as { metadata: { name: string } }).metadata.name).toBe(
      "@dsh-forge/plugin-vision",
    );
    expect(Array.isArray((def as { tools: unknown[] }).tools)).toBe(true);
  });
});

// --------------------------------------------------------- contract suite ---

describe("contract suite", () => {
  it("passes the shared plugin contract kit", async () => {
    const report = await runContractSuite(visionPlugin, {
      workspaceRoot,
      missingBinaryTool: "vision_inspect",
      missingBinaryToolArgs: { input: "sample.png" },
      toolArgs: {
        vision_inspect: {
          valid: { input: "sample.png" },
          invalid: { input: 42 },
        },
        data_analyze: {
          valid: { data: "sales.csv" },
          invalid: { data: 42 },
        },
        chart_generate: {
          valid: {
            series: [
              { label: "A", value: 1 },
              { label: "B", value: 2 },
            ],
            type: "bar",
            output: "suite-chart.svg",
          },
          invalid: { type: "bar" },
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
