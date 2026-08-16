/**
 * ISSUE-028 documentation gate.
 *
 * Docs issue — validation via a doc-link checker test:
 *  1. Every plugin package and `@dsh-forge/core` ships a README.md.
 *  2. Relative markdown links in those READMEs resolve to real files.
 *  3. Every documented example directory exists and has a runnable README.
 *  4. Tool names documented in plugin READMEs and example guides exist in the
 *     actually-registered plugin tools (no invented tool names).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** All packages that must ship a README (plugin packages + core). */
function packageDirs(): string[] {
  return readdirSync(join(ROOT, "packages"))
    .filter((d) => d.startsWith("plugin-") || d === "core")
    .map((d) => join(ROOT, "packages", d));
}

interface RegisteredTool {
  name: string;
  mutationClass?: string;
  args: string[];
}

/**
 * Load a plugin package and return its registered tool names plus the
 * mutationClass and input-schema argument names for each tool. Plugins
 * export either a default `Plugin` object or a named `*Plugin` object:
 * `{ metadata, tools }`.
 */
async function registeredTools(
  dir: string,
): Promise<{ name: string; tools: RegisteredTool[] } | undefined> {
  const pkg = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as { name: string; main?: string; module?: string };
  const entry = pkg.module ?? pkg.main ?? "src/index.ts";
  const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<
    string,
    {
      tools?: {
        name?: string;
        mutationClass?: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }[];
    } | undefined
  >;
  const plugin =
    mod.default ??
    Object.values(mod).find((v) => v && Array.isArray(v.tools) && v.tools.length > 0);
  if (!plugin?.tools) return undefined;
  const tools: RegisteredTool[] = [];
  for (const t of plugin.tools) {
    if (t.name === undefined) continue;
    tools.push({
      name: t.name,
      mutationClass: t.mutationClass,
      args: Object.keys(t.inputSchema?.properties ?? {}),
    });
  }
  return { name: pkg.name, tools };
}

/** Extract `[text](target)` markdown link targets from a README. */
function markdownLinks(readme: string): string[] {
  const links: string[] = [];
  // Matches [text](target) where target is not a URL, anchor, or mailto.
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(readme)) !== null) {
    const group = m[1];
    if (group === undefined) continue;
    const target = group.trim();
    if (
      /^(https?:|mailto:|#)/.test(target) ||
      target.startsWith("http") ||
      target.includes("://")
    ) {
      continue;
    }
    // Strip optional title suffix `"..."` if present.
    const firstPart = target.split(/\s+"[^"]*"$/)[0];
    if (firstPart === undefined) continue;
    links.push(firstPart.trim());
  }
  return links;
}

/** Tool names referenced in a document (backtick-quoted tool-like names). */
function documentedToolNames(text: string): string[] {
  const found = new Set<string>();
  const re = /`([a-z][a-z0-9_]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    // Only names that look like registered tool identifiers (contains an
    // underscore family prefix, e.g. ruff_check, k6_run, ast_search).
    if (/^[a-z0-9]+_[a-z0-9_]+$/.test(name)) found.add(name);
  }
  return [...found];
}

/** Parse the tool table rows `| tool | class | args |` from a README. */
function toolTableRows(readme: string): Map<string, { cls?: string; args?: string }> {
  const rows = new Map<string, { cls?: string; args?: string }>();
  for (const rawLine of readme.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const nameMatch = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(line);
    if (nameMatch === null) continue;
    const name = nameMatch[1];
    if (name === undefined) continue;
    // Split on unescaped pipes (table columns); `\|` inside a cell is an
    // escaped literal pipe (e.g. `js\|jsx`) and must not split the column.
    // The leading/trailing `|` of a Markdown row produce empty edge cells.
    const cells = line
      .replace(/(^|[^\\])\|/g, (_, pre) => `${pre}\u0000`)
      .split("\u0000")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    // cells[0] = tool name cell; cells[1] = MutationClass; cells[2] = args.
    rows.set(name, { cls: cells[1] || undefined, args: cells[2] || undefined });
  }
  return rows;
}

describe("ISSUE-028 documentation", () => {
  it("ships a README.md for every plugin package and core", () => {
    const dirs = packageDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(11);
    for (const dir of dirs) {
      expect(
        existsSync(join(dir, "README.md")),
        `${dir} is missing README.md`,
      ).toBe(true);
    }
  });

  it("resolves every relative markdown link inside package READMEs", () => {
    for (const dir of packageDirs()) {
      const readmePath = join(dir, "README.md");
      if (!existsSync(readmePath)) continue; // reported by the previous test
      const readme = readFileSync(readmePath, "utf8");
      for (const target of markdownLinks(readme)) {
        if (target.includes(" ")) continue; // not a bare file path
        const abs = resolve(dirname(readmePath), target);
        expect(
          existsSync(abs),
          `${readmePath} links to missing target: ${target}`,
        ).toBe(true);
      }
    }
  });

  it("documents only tools that plugins actually register", async () => {
    // Build the global tool registry first (all plugin packages).
    const allTools = new Set<string>();
    for (const dir of packageDirs()) {
      if (!dir.includes("plugin-")) continue;
      const reg = await registeredTools(dir);
      expect(reg, `${dir} does not export a default Plugin with tools`).toBeDefined();
      if (!reg) continue;
      for (const t of reg.tools) allTools.add(t.name);
    }
    for (const dir of packageDirs()) {
      if (!dir.includes("plugin-")) continue; // core has no tools
      const readmePath = join(dir, "README.md");
      if (!existsSync(readmePath)) continue;
      const reg = await registeredTools(dir);
      if (!reg) continue;
      const readme = readFileSync(readmePath, "utf8");
      const documented = documentedToolNames(readme);
      for (const name of documented) {
        expect(
          allTools.has(name),
          `${reg.name} README documents unknown tool "${name}"`,
        ).toBe(true);
      }
      // Every registered tool should be documented at least once in its own README.
      for (const tool of reg.tools) {
        expect(
          readme.includes(tool.name),
          `${reg.name} tool "${tool.name}" is not documented in its README`,
        ).toBe(true);
      }
    }
  });

  it("documents accurate MutationClass and argument columns in tool tables", async () => {
    for (const dir of packageDirs()) {
      if (!dir.includes("plugin-")) continue;
      const readmePath = join(dir, "README.md");
      if (!existsSync(readmePath)) continue;
      const reg = await registeredTools(dir);
      if (!reg) continue;
      const readme = readFileSync(readmePath, "utf8");
      const rows = toolTableRows(readme);
      for (const tool of reg.tools) {
        const row = rows.get(tool.name);
        if (!row) continue; // no table row for this tool (documented in prose)
        // MutationClass column must match the registered class.
        if (row.cls && tool.mutationClass) {
          expect(
            row.cls,
            `${reg.name} README lists wrong MutationClass for ${tool.name}`,
          ).toBe(tool.mutationClass);
        }
        // Every required argument name must appear in the args column.
        if (row.args && tool.args.length > 0) {
          for (const arg of tool.args) {
            expect(
              row.args.includes(arg),
              `${reg.name} README table for ${tool.name} omits argument "${arg}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("documents only real tools in the example guides", async () => {
    const allTools = new Set<string>();
    for (const dir of packageDirs()) {
      if (!dir.includes("plugin-")) continue;
      const reg = await registeredTools(dir);
      if (reg) for (const t of reg.tools) allTools.add(t.name);
    }
    const examplesRoot = join(ROOT, "examples");
    if (!existsSync(examplesRoot)) return; // reported by the examples test
    for (const entry of readdirSync(examplesRoot)) {
      const readmePath = join(examplesRoot, entry, "README.md");
      if (!existsSync(readmePath)) continue;
      const readme = readFileSync(readmePath, "utf8");
      for (const name of documentedToolNames(readme)) {
        expect(
          allTools.has(name),
          `examples/${entry}/README.md references unknown tool "${name}"`,
        ).toBe(true);
      }
    }
  });

  it("documents the six example scenarios with a runnable README", () => {
    const examples = [
      "python-quality",
      "web-quality",
      "security-scan",
      "local-ci",
      "load-test",
      "media",
    ];
    const examplesRoot = join(ROOT, "examples");
    expect(existsSync(examplesRoot), "examples/ directory missing").toBe(true);
    for (const name of examples) {
      const dir = join(examplesRoot, name);
      expect(existsSync(dir), `examples/${name} directory missing`).toBe(true);
      expect(
        existsSync(join(dir, "README.md")),
        `examples/${name}/README.md missing`,
      ).toBe(true);
    }
  });

  it("documents the seven presets in the presets package README", () => {
    const readmePath = join(ROOT, "presets", "presets", "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    for (const preset of [
      "coding",
      "python",
      "web",
      "security",
      "devops",
      "media",
      "full",
    ]) {
      expect(
        readme.includes(preset),
        `presets README does not document preset "${preset}"`,
      ).toBe(true);
    }
  });
});
