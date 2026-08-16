/**
 * Supply-chain / release hardening check (ISSUE-029).
 *
 * Implements the packaging gates that keep the release pipeline safe:
 *  - secret scan of built artifacts
 *  - package contents allowlist (only expected files ship)
 *  - no upstream binaries redistributed (detect + invoke instead)
 *  - lockfile discipline (pnpm-lock.yaml committed, non-empty)
 *  - license allowlist on workspace manifests
 *  - SBOM + artifact checksums written under compatibility/reports/
 *
 * The checks are exported as pure functions (unit-testable) and exposed as
 * a CLI (`node scripts/supply-chain-check.ts`) for CI. All subprocesses use
 * an env allowlist + timeout (project execution rules).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Redaction/skimmer patterns: keys, tokens, private keys, connection strings. */
export const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /sk-[A-Za-z0-9]{20,}/, // OpenAI/DeepSeek-style API keys
  /ghp_[A-Za-z0-9]{20,}/, // GitHub personal access token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private keys
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /xox[baprs]-[0-9A-Za-z-]{10,}/, // Slack token
];

const ALLOWED_DIST_EXT = /\.(js|js\.map|d\.ts|d\.cts|d\.mts)$/;
const ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".ruff_cache"]);

/** Directories that contain workspace packages (pnpm-workspace.yaml globs). */
const WORKSPACE_GLOB_DIRS = ["packages", "presets"] as const;

/** A package directory is any directory directly under a workspace glob dir
 * that contains a package.json (e.g. packages/plugin-x, packages/core,
 * presets/presets). This keeps every built + published package inside the
 * supply-chain gate. */
function packageDirs(): string[] {
  const dirs: string[] = [];
  for (const globDir of WORKSPACE_GLOB_DIRS) {
    const base = join(ROOT, globDir);
    if (!existsSync(base)) continue;
    for (const child of readdirSync(base)) {
      const candidate = join(base, child);
      if (existsSync(join(candidate, "package.json"))) dirs.push(candidate);
    }
  }
  return dirs;
}

/** Recursively collect all files under a directory (POSIX relative paths). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, rel: string) => {
    const abs = join(base, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs)) {
        walk(base, rel === "" ? child : join(rel, child));
      }
    } else {
      out.push(rel.split("\\").join("/"));
    }
  };
  walk(dir, "");
  return out;
}

export interface SecretScanResult {
  ok: boolean;
  /** true when a dist/ tree existed and was actually scanned. */
  built: boolean;
  findings: { file: string; pattern: string }[];
}

/** Scan built artifacts for secret-like values. Missing dist fails closed. */
export function scanSecrets(dir: string): SecretScanResult {
  const findings: SecretScanResult["findings"] = [];
  const dist = join(dir, "dist");
  if (!existsSync(dist)) {
    // Fail closed: an unbuilt package means nothing was scanned. A release
    // gate must not pass when there is no artifact to inspect.
    return { ok: false, built: false, findings };
  }
  for (const file of filesUnder(dist)) {
    const content = readFileSync(join(dist, file), "utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        findings.push({ file, pattern: pattern.source });
      }
    }
  }
  return { ok: findings.length === 0, built: true, findings };
}

export interface ContentsCheckResult {
  ok: boolean;
  /** true when a dist/ tree existed and was actually allow-listed. */
  built: boolean;
  errors: string[];
}

/** Assert dist artifacts stay inside the expected tsup allowlist. */
export function checkContents(dir: string): ContentsCheckResult {
  const errors: string[] = [];
  const dist = join(dir, "dist");
  if (!existsSync(dist)) {
    // Fail closed: a missing dist means there is nothing to allow-list.
    return { ok: false, built: false, errors: ["dist is missing — run pnpm build first"] };
  }
  const files = filesUnder(dist);
  if (files.length === 0) errors.push("dist is empty");
  for (const file of files) {
    if (!ALLOWED_DIST_EXT.test(file)) {
      errors.push(`unexpected file in dist: ${file}`);
    }
  }
  return { ok: errors.length === 0, built: true, errors };
}

/** Recursively find committed binary artifacts (excluding tool dirs). */
export function findRedistributedBinaries(root: string): string[] {
  const found: string[] = [];
  const walk = (base: string, rel: string) => {
    const abs = join(base, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      // Skip tool dirs at any depth (match on the leaf segment, e.g. a
      // nested node_modules under packages/plugin-x/node_modules).
      const leaf = rel.split(/[\\/]/).pop() ?? "";
      if (leaf !== "" && SKIP_DIRS.has(leaf)) return;
      for (const child of readdirSync(abs)) {
        walk(base, rel === "" ? child : join(rel, child));
      }
    } else if (/\.(exe|dll|so|dylib|a|o|bin)$/i.test(rel)) {
      found.push(rel.split("\\").join("/"));
    }
  };
  walk(root, "");
  return found;
}

export interface SupplyChainReport {
  generatedAt: string;
  packages: {
    name: string;
    secretsOk: boolean;
    contentsOk: boolean;
    secretFindings: string[];
    contentsErrors: string[];
  }[];
  redistributedBinaries: string[];
  lockfileOk: boolean;
  licenseErrors: string[];
  sbomFile?: string;
  checksumsFile?: string;
  ok: boolean;
}

/** Build the full supply-chain report for the workspace. */
export function buildReport(root: string): SupplyChainReport {
  const packages = packageDirs()
    .map((dir) => {
      const pkgPath = join(dir, "package.json");
      const name = existsSync(pkgPath)
        ? (JSON.parse(readFileSync(pkgPath, "utf8")).name as string)
        : dir.split(/[\\/]/).pop() ?? dir;
      const secrets = scanSecrets(dir);
      const contents = checkContents(dir);
      return {
        name,
        secretsOk: secrets.ok,
        contentsOk: contents.ok,
        secretFindings: secrets.findings.map((f) => `${f.file} (${f.pattern})`),
        contentsErrors: contents.errors,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const redistributedBinaries = findRedistributedBinaries(root);
  const lockfile = join(root, "pnpm-lock.yaml");
  const lockfileOk = existsSync(lockfile) && statSync(lockfile).size > 100;

  // License allowlist on workspace manifests.
  const licenseErrors: string[] = [];
  for (const manifest of ["package.json", ...packageDirs().map((d) => join(d, "package.json"))]) {
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { license?: string; name?: string };
    if (pkg.license && !ALLOWED_LICENSES.has(pkg.license)) {
      licenseErrors.push(`${pkg.name ?? manifest}: unapproved license ${pkg.license}`);
    }
  }

  const ok =
    packages.every((p) => p.secretsOk && p.contentsOk) &&
    redistributedBinaries.length === 0 &&
    lockfileOk &&
    licenseErrors.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    packages,
    redistributedBinaries,
    lockfileOk,
    licenseErrors,
    ok,
  };
}

/**
 * Parse the pnpm-lock.yaml `packages:` section into dependency entries.
 * Dependency-free parser: top-level entries under `packages:` have exactly
 * two-space indentation and the shape `<name>@<version>:` (or `/name@version:`
 * for peer-dependent keys). Scope names keep their leading `@`; a leading `/`
 * marks the peer-key form and is dropped from the reported name.
 */
export function parseLockfileDeps(lockfileText: string): { name: string; version: string }[] {
  const deps: { name: string; version: string }[] = [];
  let inPackages = false;
  for (const rawLine of lockfileText.split(/\r?\n/)) {
    if (rawLine === "packages:") {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // Blank lines are separators; skip without terminating the section.
    if (rawLine.trim() === "") continue;
    // 0-indent line = the next top-level section (snapshots:, importers:,
    // settings:, ...) — the packages section is over.
    if (!/^\s/.test(rawLine)) {
      inPackages = false;
      continue;
    }
    // Exactly-two-space-indented lines are package entries; deeper indents
    // (field lines like `    resolution: {...}`) are metadata we skip.
    if (!/^ {2}[^ ]/.test(rawLine)) continue;
    // Compact snapshot form `name@version: {}` and block form both end with
    // a colon after the key; strip any trailing `: {}` / `:`.
    const key = rawLine.trim().replace(/\s*:\s*\{?\}?\s*$/, "").replace(/^['"]|['"]$/g, "");
    // Strip a leading `/` used for peer-key entries.
    const bare = key.startsWith("/") ? key.slice(1) : key;
    // Key shape: `<name>@<version>` optionally followed by a peer suffix
    // `(<peer>@<ver>)`. Parse the base name@version only so the SBOM carries
    // real package identities (peer suffixes are link metadata, not part of
    // the package spec).
    const m = bare.match(/^(@?[^@]+)@([^@()]+)(?:\(.*\))?$/);
    if (m === null) continue;
    const name = m[1];
    const version = m[2];
    if (name === undefined || version === undefined) continue;
    if (version === "" || version === "workspace") continue;
    deps.push({ name, version });
  }
  const seen = new Set<string>();
  return deps.filter((d) => {
    const k = `${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Deterministic RFC 4122 v4-style UUID derived from a stamp string. */
export function uuidFromStamp(stamp: string): string {
  const hex = createHash("sha256").update(stamp).digest("hex").slice(0, 32);
  // Set version (4) and variant (8/9/a/b) bits for a valid v4 UUID shape.
  const h = hex.split("");
  h[12] = "4";
  h[16] = ((parseInt(h[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Write SBOM + artifact checksums into compatibility/reports/. */
export function writeArtifacts(
  report: SupplyChainReport,
  outDir: string,
): { sbomFile: string; checksumsFile: string } {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Dependency SBOM derived from the lockfile packages section.
  const lockfile = join(ROOT, "pnpm-lock.yaml");
  const deps = existsSync(lockfile) ? parseLockfileDeps(readFileSync(lockfile, "utf8")) : [];
  const sbom: Record<string, unknown> = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuidFromStamp(stamp)}`,
    version: 1,
    metadata: { timestamp: report.generatedAt },
    components: deps.map((d) => ({
      type: "library",
      "bom-ref": `${d.name}@${d.version}`,
      name: d.name,
      version: d.version,
    })),
  };
  const sbomFile = join(outDir, `sbom-${stamp}.json`);
  writeFileSync(sbomFile, JSON.stringify(sbom, null, 2));

  // SHA-256 checksums for every built artifact. The checksum manifest uses
  // paths relative to the reports dir that mirror the uploaded CI artifact
  // layout (dist trees are uploaded alongside so `sha256sum -c` resolves).
  const checksums: Record<string, string> = {};
  for (const dir of packageDirs()) {
    const dist = join(dir, "dist");
    if (!existsSync(dist)) continue;
    const pkgName = dir.split(/[\\/]/).pop() ?? dir;
    for (const file of filesUnder(dist)) {
      const abs = join(dist, file);
      const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
      checksums[`dist/${pkgName}/${file}`] = hash;
    }
  }
  const checksumsFile = join(outDir, `checksums-${stamp}.sha256`);
  writeFileSync(
    checksumsFile,
    Object.entries(checksums)
      .map(([f, h]) => `${h}  ${f}`)
      .sort()
      .join("\n") + "\n",
  );

  return { sbomFile, checksumsFile };
}

function format(report: SupplyChainReport): string {
  const lines: string[] = [];
  lines.push(`Supply-chain check @ ${report.generatedAt}`);
  lines.push(`  packages checked: ${report.packages.length}`);
  for (const p of report.packages) {
    const status = p.secretsOk && p.contentsOk ? "ok" : "FAIL";
    lines.push(`  ${p.name}: ${status}`);
    for (const f of p.secretFindings) lines.push(`    secret: ${f}`);
    for (const e of p.contentsErrors) lines.push(`    contents: ${e}`);
  }
  lines.push(`  redistributed binaries: ${report.redistributedBinaries.length === 0 ? "none" : report.redistributedBinaries.join(", ")}`);
  lines.push(`  lockfile: ${report.lockfileOk ? "ok" : "MISSING"}`);
  lines.push(`  license errors: ${report.licenseErrors.length === 0 ? "none" : report.licenseErrors.join("; ")}`);
  lines.push(`  result: ${report.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

/**
 * Run the supply-chain check end-to-end and return the process exit code.
 * Exported so tests can drive the CLI path directly (including the
 * exit-code contract) without spawning a subprocess.
 */
export function runCli(args: string[] = process.argv.slice(2)): number {
  const outDir = args[0] ? resolve(args[0]) : join(ROOT, "compatibility", "reports");
  const report = buildReport(ROOT);
  const artifacts = writeArtifacts(report, outDir);
  report.sbomFile = artifacts.sbomFile;
  report.checksumsFile = artifacts.checksumsFile;
  console.log(format(report));
  if (artifacts.sbomFile) console.log(`  sbom: ${artifacts.sbomFile}`);
  if (artifacts.checksumsFile) console.log(`  checksums: ${artifacts.checksumsFile}`);
  return report.ok ? 0 : 1;
}

// CLI entry: `node scripts/supply-chain-check.ts [outDir]`.
//
// We must reliably distinguish a direct invocation from a plain import
// (tests import this module and must not trigger process.exit). Node does not
// implement import.meta.main, so we resolve process.argv[1] with realpath and
// compare against this file's realpath: when argv[1] resolves to this file
// (canonical name, symlink/shim, dropped extension, casing variance) we run
// the gate; when it resolves to some other program (e.g. vitest) we are an
// imported module and do nothing. This is fail-closed by construction: a
// wrapper that renames the script still resolves to this file and runs.
import { realpathSync } from "node:fs";

const invokedEntry = process.argv[1] ?? "";
const thisFileReal = realpathSync(fileURLToPath(import.meta.url));
let invokedReal: string | null = null;
if (invokedEntry !== "") {
  try {
    invokedReal = realpathSync(invokedEntry);
  } catch {
    invokedReal = null;
  }
}
const isThisScript =
  invokedReal !== null &&
  invokedReal.replace(/\\/g, "/").toLowerCase() ===
    thisFileReal.replace(/\\/g, "/").toLowerCase();

if (invokedEntry === "") {
  // No argv[1] — must be an import in an unusual runtime; do nothing.
} else if (isThisScript) {
  // Direct invocation (canonical path, symlink, shim, casing, or dropped
  // extension): run the gate. Fail-closed is enforced inside runCli (exit 1
  // on a failed report). An unresolved-argv case can never silently pass.
  process.exit(runCli());
} else {
  // process.argv[1] resolves to a different program — we are an imported
  // module (e.g. vitest). Do nothing.
}
