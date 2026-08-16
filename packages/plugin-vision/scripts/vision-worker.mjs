#!/usr/bin/env node
/* global process, Buffer */
/**
 * Deterministic worker for @dsh-forge/plugin-vision (ISSUE-062).
 *
 * Runs fully offline. Implements three typed subcommands used by the plugin
 * tools (spawned via the current Node executable, typed argv, never a shell):
 *
 *   inspect --image <absPath> [--task <text>]
 *       Image header parsing (PNG/JPEG/WebP/GIF/BMP) plus color/contrast
 *       heuristics sampled from decoded PNG pixels. Never loads the whole
 *       image into the model; emits a compact JSON report.
 *
 *   analyze --data <absPath>
 *       CSV / JSON analysis: row/column counts, schema, per-column
 *       descriptive statistics, and lightweight diagnostics.
 *
 *   chart --data <absPath> | --series <json> --type <bar|line|pie|area|scatter>
 *         [--title <text>] [--width <n>] [--height <n>] --out <absPath>
 *       Pure-SVG chart generation (no binary dependency) written to the
 *       workspace path validated by the plugin.
 *
 * Every command prints exactly one JSON document to stdout and exits 0 on
 * success, or 1 with { ok:false, error:{ code, message } } on failure.
 */
import { readFileSync, writeFileSync, statSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHART_TYPES = ["bar", "line", "pie", "area", "scatter"];
const PALETTE = [
  "#4f7cff",
  "#ff8c42",
  "#33c48d",
  "#ff4f6d",
  "#9b59b6",
  "#f1c40f",
  "#2ecc71",
  "#e74c3c",
  "#1abc9c",
  "#3498db",
];

/** Exit 1 with a JSON error document (synchronous write so output is flushed). */
function die(code, message) {
  writeSync(1, JSON.stringify({ ok: false, error: { code, message } }));
  process.exit(1);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Parse `--key value` pairs (values may be omitted -> true). */
function readArgv(args) {
  const map = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (typeof k === "string" && k.startsWith("--")) {
      const next = args[i + 1];
      if (
        next === undefined ||
        (typeof next === "string" && next.startsWith("--"))
      ) {
        map[k.slice(2)] = true;
      } else {
        map[k.slice(2)] = next;
        i++;
      }
    }
  }
  return map;
}

/** Strip XML 1.0 control characters (keeping tab/LF/CR as valid whitespace). */
function stripControlChars(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    if (c === 0x7f) continue;
    out += s[i];
  }
  return out;
}

function escapeXml(s) {
  return stripControlChars(String(s)).replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c],
  );
}

function truncateLabel(s, max = 12) {
  const t = String(s);
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/** Parse a numeric cell: strips currency/thousands separators; null if not a number. */
function toNumberValue(x) {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string") {
    const t = x.trim().replace(/[,¥$€£%]/g, "");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------------------------------------------------------------- image ---

function readUint16BE(b, o) {
  return (b[o] << 8) | b[o + 1];
}
function readUint32BE(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function readUint16LE(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function readUint32LE(b, o) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

/** Decode pixel samples from a non-interlaced 8-bit PNG (RGB/RGBA/gray). */
function samplePngPixels(buf, width, height, colorType) {
  if (width * height > 16_000_000) return undefined; // skip huge images
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const bpp = channels;
  const stride = width * bpp;
  const idat = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = readUint32BE(buf, off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT" && off + 8 + len <= buf.length) {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    }
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (idat.length === 0) return undefined;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  if (raw.length < (stride + 1) * height) return undefined;
  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst + x - stride] : 0;
      const c = x >= bpp && y > 0 ? out[dst + x - stride - bpp] : 0;
      const cur = raw[src + x];
      let val;
      switch (f) {
        case 0:
          val = cur;
          break;
        case 1:
          val = cur + a;
          break;
        case 2:
          val = cur + b;
          break;
        case 3:
          val = cur + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return undefined;
      }
      out[dst + x] = val & 0xff;
    }
  }
  // Sample up to ~4k pixels spread across the image.
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
  let n = 0;
  let lumSum = 0;
  let lumSq = 0;
  let dark = 0;
  let gray = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const p = y * stride + x * channels;
      let r;
      let g;
      let b;
      if (channels === 1) {
        r = g = b = out[p];
      } else {
        r = out[p];
        g = out[p + 1];
        b = out[p + 2];
      }
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumSum += lum;
      lumSq += lum * lum;
      if (lum < 0.2) dark++;
      if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) gray++;
      n++;
    }
  }
  if (n === 0) return undefined;
  const mean = lumSum / n;
  const variance = Math.max(0, lumSq / n - mean * mean);
  return {
    meanLuminance: round2(mean),
    luminanceStddev: round2(Math.sqrt(variance)),
    darkPixelRatio: round2(dark / n),
    grayscaleRatio: round2(gray / n),
    sampledPixels: n,
  };
}

function parsePng(buf, size) {
  if (buf.length < 33) {
    return {
      ok: false,
      error: { code: "ParseFailure", message: "truncated PNG header" },
    };
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") {
    return {
      ok: false,
      error: { code: "ParseFailure", message: "PNG missing IHDR chunk" },
    };
  }
  const width = readUint32BE(buf, 16);
  const height = readUint32BE(buf, 20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (width === 0 || height === 0) {
    return {
      ok: false,
      error: { code: "ParseFailure", message: "invalid PNG dimensions" },
    };
  }
  let stats;
  if (
    bitDepth === 8 &&
    interlace === 0 &&
    (colorType === 0 || colorType === 2 || colorType === 6)
  ) {
    stats = samplePngPixels(buf, width, height, colorType);
  }
  return {
    ok: true,
    format: "png",
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    size,
    stats,
  };
}

function parseJpeg(buf, size) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      off += 2;
      continue;
    }
    if (off + 4 > buf.length) break;
    const len = readUint16BE(buf, off + 2);
    if (len < 2) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && off + 9 <= buf.length) {
      const height = readUint16BE(buf, off + 5);
      const width = readUint16BE(buf, off + 7);
      return { ok: true, format: "jpeg", width, height, size };
    }
    off += 2 + len;
  }
  return {
    ok: false,
    error: { code: "ParseFailure", message: "no JPEG frame (SOF) found" },
  };
}

function parseWebp(buf, size) {
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8X") {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { ok: true, format: "webp", width: w, height: h, size };
  }
  if (fourcc === "VP8 ") {
    const w = readUint16LE(buf, 26);
    const h = readUint16LE(buf, 28);
    return { ok: true, format: "webp", width: w, height: h, size };
  }
  if (fourcc === "VP8L") {
    const bits = readUint32LE(buf, 21);
    const w = 1 + (bits & 0x3fff);
    const h = 1 + ((bits >> 14) & 0x3fff);
    return { ok: true, format: "webp", width: w, height: h, size };
  }
  return {
    ok: false,
    error: { code: "ParseFailure", message: "unrecognized WebP variant" },
  };
}

function parseGif(buf, size) {
  const w = readUint16LE(buf, 6);
  const h = readUint16LE(buf, 8);
  return { ok: true, format: "gif", width: w, height: h, size };
}

function parseBmp(buf, size) {
  const dib = readUint32LE(buf, 14);
  let w;
  let h;
  if (dib === 12) {
    w = readUint16LE(buf, 18);
    h = readUint16LE(buf, 20);
  } else {
    w = buf.readInt32LE(18);
    h = Math.abs(buf.readInt32LE(22));
  }
  return { ok: true, format: "bmp", width: w, height: h, size };
}

/** Detect format and parse dimensions/stats from the leading bytes. */
function parseImage(absPath) {
  const buf = readFileSync(absPath);
  const size = buf.length;
  if (buf.length >= 8 && PNG_SIG.every((v, i) => buf[i] === v)) {
    return parsePng(buf, size);
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return parseJpeg(buf, size);
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return parseWebp(buf, size);
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") {
    return parseGif(buf, size);
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return parseBmp(buf, size);
  }
  return {
    ok: false,
    error: {
      code: "UnsupportedFormat",
      message:
        "unsupported or unrecognized image format (expected PNG/JPEG/WebP/GIF/BMP)",
    },
  };
}

function imageDiagnostics(parsed) {
  const diags = [];
  if (!parsed.ok) {
    diags.push({
      rule: "unrecognized-format",
      severity: "error",
      message: parsed.error.message,
      suggestion: "provide a PNG/JPEG/WebP/GIF/BMP image",
    });
    return diags;
  }
  const { format, width, height, stats } = parsed;
  if (width < 100 || height < 100) {
    diags.push({
      rule: "tiny-image",
      severity: "warning",
      message: `image is ${width}x${height}; UI text is likely unreadable at this size`,
      suggestion: "use a full-size screenshot (at least 320px wide)",
    });
  }
  const ratio = width / Math.max(1, height);
  if (ratio > 8 || ratio < 0.125) {
    diags.push({
      rule: "extreme-aspect-ratio",
      severity: "info",
      message: `extreme aspect ratio ${round2(ratio)}:1 (${format})`,
      suggestion: "verify the captured region matches the UI under review",
    });
  }
  if (stats) {
    if (stats.luminanceStddev < 0.08) {
      diags.push({
        rule: "low-contrast",
        severity: "warning",
        message: `low contrast (luminance stddev ${stats.luminanceStddev})`,
        suggestion: "check text/background contrast for readability",
      });
    }
    if (stats.darkPixelRatio > 0.7) {
      diags.push({
        rule: "dark-theme",
        severity: "info",
        message: `mostly dark image (${Math.round(stats.darkPixelRatio * 100)}% dark pixels)`,
        suggestion: "confirm the intended theme (dark vs light)",
      });
    }
    if (stats.grayscaleRatio > 0.9) {
      diags.push({
        rule: "grayscale",
        severity: "info",
        message: "image appears grayscale",
        suggestion: "color-coded states may not be distinguishable",
      });
    }
  }
  return diags;
}

function cmdInspect(args) {
  const a = readArgv(args);
  if (!a.image) {
    return {
      ok: false,
      error: { code: "InvalidArguments", message: "inspect requires --image" },
    };
  }
  let parsed;
  try {
    parsed = parseImage(a.image);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ToolFailure",
        message: `could not read image: ${err.message}`,
      },
    };
  }
  if (!parsed.ok) return parsed;
  const diags = imageDiagnostics(parsed);
  if (a.task) {
    diags.push({
      rule: "backend-unavailable",
      severity: "info",
      message:
        "model-based design review is not available in this build; returning structural heuristics only",
      suggestion:
        "review the structural diagnostics (format, dimensions, contrast) below",
    });
  }
  return {
    ok: true,
    format: parsed.format,
    width: parsed.width,
    height: parsed.height,
    aspectRatio: round2(parsed.width / Math.max(1, parsed.height)),
    fileSize: parsed.size,
    stats: parsed.stats ?? null,
    diagnostics: diags,
    task: a.task || null,
  };
}

// ------------------------------------------------------------------ data ---

/** Read a data file as UTF-8, stripping a leading BOM if present. */
function readDataText(absPath) {
  return readFileSync(absPath, "utf8").replace(/^\uFEFF/, "");
}

/** Minimal RFC-4180-ish CSV parser (quotes, CRLF, embedded commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** Normalize a parsed JSON document into rows: [[header...], [values...]]. */
function normalizeJsonRows(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const first = value[0];
    if (Array.isArray(first)) return value;
    if (first !== null && typeof first === "object") {
      const keys = Object.keys(first);
      if (keys.length === 0) return [];
      return [keys, ...value.map((o) => keys.map((k) => o[k] ?? ""))];
    }
    return [["value"], ...value.map((x) => [x])];
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value.rows)) return normalizeJsonRows(value.rows);
    if (Array.isArray(value.data)) return normalizeJsonRows(value.data);
    if (Array.isArray(value.values)) return normalizeJsonRows(value.values);
  }
  return [];
}

function dataDiagnostics(schema, stats, body) {
  const diags = [];
  if (body.length === 0) {
    diags.push({
      rule: "empty-data",
      severity: "error",
      message: "no data rows after the header row",
      suggestion: "provide at least one data row to analyze",
    });
  }
  if (body.length > 100_000) {
    diags.push({
      rule: "large-dataset",
      severity: "info",
      message: `dataset has ${body.length} rows`,
      suggestion: "aggregate before charting",
    });
  }
  for (const s of stats) {
    if (s.type === "number" && s.count > 0 && s.max === s.min) {
      diags.push({
        rule: "constant-column",
        severity: "info",
        message: `column "${s.name}" is constant (${s.min})`,
        suggestion: "it adds no distinguishing signal",
      });
    }
    if (s.type === "string" && s.count > 0 && s.unique === 1) {
      diags.push({
        rule: "constant-column",
        severity: "info",
        message: `column "${s.name}" has a single distinct value`,
        suggestion: "it adds no distinguishing signal",
      });
    }
  }
  for (const col of schema) {
    const missingRatio = body.length === 0 ? 0 : col.missing / body.length;
    if (missingRatio > 0.5) {
      diags.push({
        rule: "missing-values",
        severity: "warning",
        message: `column "${col.name}" is missing ${col.missing}/${body.length} values`,
        suggestion: "fill or drop the column before analysis",
      });
    }
  }
  return diags;
}

function cmdAnalyze(args) {
  const a = readArgv(args);
  if (!a.data) {
    return {
      ok: false,
      error: { code: "InvalidArguments", message: "analyze requires --data" },
    };
  }
  const isJson = basename(a.data).toLowerCase().endsWith(".json");
  let rows;
  try {
    const text = readDataText(a.data);
    rows = isJson ? normalizeJsonRows(JSON.parse(text)) : parseCsv(text);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ToolFailure",
        message: `could not read data: ${err.message}`,
      },
    };
  }
  if (!rows || rows.length === 0) {
    return {
      ok: false,
      error: { code: "ToolFailure", message: "no data rows found" },
    };
  }
  const headers = rows[0].map((h) => String(h).trim());
  const body = rows.slice(1);
  const schema = headers.map((name, i) => {
    const vals = body
      .map((r) => r[i])
      .filter((x) => x !== undefined && String(x).trim() !== "");
    const numeric = vals.filter((v) => toNumberValue(v) !== null);
    const type =
      vals.length > 0 && numeric.length / vals.length > 0.8
        ? "number"
        : "string";
    return { name, type, missing: body.length - vals.length };
  });
  const stats = schema.map((col, i) => {
    const vals = body
      .map((r) => r[i])
      .filter((x) => x !== undefined && String(x).trim() !== "");
    if (col.type === "number") {
      // A mixed column may be typed "number" when >80% of cells parse, so
      // filter non-numeric cells first (nulls must never coerce to 0).
      // Iterate instead of Math.min(...nums) so very large columns cannot
      // overflow the call stack (RangeError on big spread arguments).
      const nums = [];
      for (const v of vals) {
        const n = toNumberValue(v);
        if (n !== null) nums.push(n);
      }
      if (nums.length === 0) {
        return {
          name: col.name,
          type: "number",
          count: 0,
          min: null,
          max: null,
          mean: null,
          sum: null,
          stddev: null,
        };
      }
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const n of nums) {
        if (n < min) min = n;
        if (n > max) max = n;
        sum += n;
      }
      const mean = sum / nums.length;
      let variance = 0;
      for (const n of nums) variance += (n - mean) ** 2;
      variance /= nums.length;
      return {
        name: col.name,
        type: "number",
        count: nums.length,
        min: round2(min),
        max: round2(max),
        mean: round2(mean),
        sum: round2(sum),
        stddev: round2(Math.sqrt(variance)),
      };
    }
    const uniq = new Set(vals.map(String));
    const counts = new Map();
    for (const v of vals)
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    let top = null;
    let topCount = 0;
    for (const [k, c] of counts) {
      if (c > topCount) {
        top = k;
        topCount = c;
      }
    }
    return {
      name: col.name,
      type: "string",
      count: vals.length,
      unique: uniq.size,
      top,
    };
  });
  return {
    ok: true,
    format: isJson ? "json" : "csv",
    rows: body.length,
    columns: headers.length,
    schema,
    stats,
    diagnostics: dataDiagnostics(schema, stats, body),
  };
}

// ----------------------------------------------------------------- chart ---

/** Build an SVG document for a chart spec. */
function buildSvg(chart) {
  const { type, title, width, height, labels, values } = chart;
  const padL = 56;
  const padR = 16;
  const padT = 40;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const minV = Math.min(0, ...values);
  const span = Math.max(Math.max(...values) - minV, 1e-9);
  const x = (i) =>
    padL + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - minV) / span) * plotH;

  let body = "";
  const titleSvg = title
    ? `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" fill="#1a1a1a">${escapeXml(title)}</text>`
    : "";

  if (type !== "pie") {
    body += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#999"/>`;
    body += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#999"/>`;
    for (let g = 0; g <= 4; g++) {
      const gy = padT + plotH - (g / 4) * plotH;
      const gv = minV + (g / 4) * span;
      body += `<line x1="${padL}" y1="${round2(gy)}" x2="${padL + plotW}" y2="${round2(gy)}" stroke="#eee"/>`;
      body += `<text x="${padL - 6}" y="${round2(gy + 4)}" text-anchor="end" font-size="10" fill="#666">${round2(gv)}</text>`;
    }
  }

  if (type === "bar") {
    const bw = Math.max(2, (plotW / labels.length) * 0.6);
    const y0 = y(0);
    values.forEach((v, i) => {
      const bx = x(i) - bw / 2;
      let by;
      let bh;
      if (v >= 0) {
        by = y(v);
        bh = y0 - y(v);
      } else {
        by = y0;
        bh = y(v) - y0;
      }
      body += `<rect x="${round2(bx)}" y="${round2(by)}" width="${round2(bw)}" height="${round2(Math.max(bh, 0.5))}" fill="${PALETTE[i % PALETTE.length]}"><title>${escapeXml(labels[i])}: ${round2(v)}</title></rect>`;
    });
    labels.forEach((l, i) => {
      body += `<text x="${round2(x(i))}" y="${height - padB + 14}" text-anchor="middle" font-size="10" fill="#666">${escapeXml(truncateLabel(l))}</text>`;
    });
  } else if (type === "line" || type === "area") {
    const pts = values
      .map((v, i) => `${round2(x(i))},${round2(y(v))}`)
      .join(" ");
    if (type === "area") {
      body += `<polygon points="${padL},${padT + plotH} ${pts} ${padL + plotW},${padT + plotH}" fill="${PALETTE[0]}" opacity="0.35"/>`;
    }
    body += `<polyline points="${pts}" fill="none" stroke="${PALETTE[0]}" stroke-width="2"/>`;
    values.forEach((v, i) => {
      body += `<circle cx="${round2(x(i))}" cy="${round2(y(v))}" r="3" fill="${PALETTE[0]}"><title>${escapeXml(labels[i])}: ${round2(v)}</title></circle>`;
    });
    labels.forEach((l, i) => {
      body += `<text x="${round2(x(i))}" y="${height - padB + 14}" text-anchor="middle" font-size="10" fill="#666">${escapeXml(truncateLabel(l))}</text>`;
    });
  } else if (type === "scatter") {
    values.forEach((v, i) => {
      body += `<circle cx="${round2(x(i))}" cy="${round2(y(v))}" r="4" fill="${PALETTE[i % PALETTE.length]}"><title>${escapeXml(labels[i])}: ${round2(v)}</title></circle>`;
    });
  } else if (type === "pie") {
    const total = values.reduce((acc, v) => acc + Math.abs(v), 0) || 1;
    const cx = width / 2;
    const cy = height / 2 + 6;
    const r = Math.min(plotW, plotH) / 2 - 10;
    if (values.length === 1) {
      // A single point would degenerate to a zero-length arc; draw a full
      // circle instead.
      const v = values[0];
      body += `<circle cx="${round2(cx)}" cy="${round2(cy)}" r="${r}" fill="${PALETTE[0]}"><title>${escapeXml(labels[0])}: ${round2(v)} (100%)</title></circle>`;
    } else {
      let angle = -Math.PI / 2;
      values.forEach((v, i) => {
        const frac = Math.abs(v) / total;
        const a2 = angle + frac * 2 * Math.PI;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(a2);
        const y2 = cy + r * Math.sin(a2);
        const large = frac > 0.5 ? 1 : 0;
        body += `<path d="M${round2(cx)},${round2(cy)} L${round2(x1)},${round2(y1)} A${r},${r} 0 ${large} 1 ${round2(x2)},${round2(y2)} Z" fill="${PALETTE[i % PALETTE.length]}"><title>${escapeXml(labels[i])}: ${round2(v)} (${Math.round(frac * 100)}%)</title></path>`;
        angle = a2;
      });
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${titleSvg}${body}</svg>`;
}

function cmdChart(args) {
  const a = readArgv(args);
  if (!a.out) {
    return {
      ok: false,
      error: { code: "InvalidArguments", message: "chart requires --out" },
    };
  }
  if (!a.type || !CHART_TYPES.includes(a.type)) {
    return {
      ok: false,
      error: {
        code: "InvalidArguments",
        message: `chart type must be one of: ${CHART_TYPES.join(", ")}`,
      },
    };
  }
  let rows = null;
  let series = null;
  if (a.data) {
    const isJson = basename(a.data).toLowerCase().endsWith(".json");
    try {
      const text = readDataText(a.data);
      rows = isJson ? normalizeJsonRows(JSON.parse(text)) : parseCsv(text);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "ToolFailure",
          message: `could not read data: ${err.message}`,
        },
      };
    }
  }
  if (a.series) {
    try {
      series = JSON.parse(a.series);
    } catch {
      return {
        ok: false,
        error: {
          code: "InvalidArguments",
          message: "--series must be valid JSON",
        },
      };
    }
  }
  if (!rows && !series) {
    return {
      ok: false,
      error: {
        code: "InvalidArguments",
        message: "chart requires --data or --series",
      },
    };
  }
  const labels = [];
  const values = [];
  if (series) {
    for (const s of series) {
      const label = String(s?.label ?? s?.x ?? "");
      const value = toNumberValue(s?.value ?? s?.y);
      if (label !== "" && value !== null) {
        labels.push(label);
        values.push(value);
      }
    }
  } else {
    for (const r of rows.slice(1)) {
      const label = String(r[0] ?? "");
      const value = toNumberValue(r[1]);
      if (label !== "" && value !== null) {
        labels.push(label);
        values.push(value);
      }
    }
  }
  if (values.length === 0) {
    return {
      ok: false,
      error: {
        code: "InvalidArguments",
        message: "no plottable (label, value) pairs found",
      },
    };
  }
  if (values.length > 2000) {
    return {
      ok: false,
      error: {
        code: "InvalidArguments",
        message: "too many data points (max 2000)",
      },
    };
  }
  const width = clampInt(a.width, 100, 4096, 800);
  const height = clampInt(a.height, 100, 4096, 400);
  const svg = buildSvg({
    type: a.type,
    title: a.title || "",
    width,
    height,
    labels,
    values,
  });
  try {
    writeFileSync(a.out, svg, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ToolFailure",
        message: `could not write chart: ${err.message}`,
      },
    };
  }
  const st = statSync(a.out);
  return {
    ok: true,
    path: a.out,
    chartType: a.type,
    width,
    height,
    dataPoints: values.length,
    fileSize: st.size,
  };
}

// ------------------------------------------------------------------ main ---

const sub = process.argv[2];
let result;
try {
  if (sub === "inspect") {
    result = cmdInspect(process.argv.slice(3));
  } else if (sub === "analyze") {
    result = cmdAnalyze(process.argv.slice(3));
  } else if (sub === "chart") {
    result = cmdChart(process.argv.slice(3));
  } else {
    die("InvalidArguments", `unknown subcommand: ${String(sub)}`);
  }
} catch (err) {
  die("ToolFailure", String((err && err.message) || err));
}
if (!result || !result.ok) {
  const e = (result && result.error) || {
    code: "ToolFailure",
    message: "worker failed",
  };
  die(String(e.code), String(e.message));
}
process.stdout.write(JSON.stringify(result));
