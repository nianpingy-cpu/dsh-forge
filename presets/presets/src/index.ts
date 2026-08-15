/**
 * Plugin presets (ISSUE-013 / ISSUE-024) — composition and configuration
 * only. A preset is a manifest that references already-implemented plugin
 * packages; no plugin code is duplicated here. The harness host can load a
 * preset and register every plugin/tool it references.
 */
import { CORE_VERSION, type Plugin } from "@dsh-forge/core";
import { astGrepPlugin } from "@dsh-forge/plugin-ast-grep";
import { ruffPlugin } from "@dsh-forge/plugin-ruff";
import { biomePlugin } from "@dsh-forge/plugin-biome";
import { uvPlugin } from "@dsh-forge/plugin-uv";
import { semgrepPlugin } from "@dsh-forge/plugin-semgrep";
import { trivyPlugin } from "@dsh-forge/plugin-trivy";
import { qualityGatePlugin } from "@dsh-forge/plugin-quality-gate";
import { actPlugin } from "@dsh-forge/plugin-act";
import { dockerPlugin } from "@dsh-forge/plugin-docker";
import { k6Plugin } from "@dsh-forge/plugin-k6";
import { ffmpegPlugin } from "@dsh-forge/plugin-ffmpeg";

export interface Preset {
  name: string;
  description: string;
  /** Plugins in registration order; no duplicate plugin/tool registrations. */
  plugins: readonly Plugin[];
}

const coding = Object.freeze([astGrepPlugin, ruffPlugin, biomePlugin]);
const python = Object.freeze([ruffPlugin, uvPlugin]);
const web = Object.freeze([biomePlugin, astGrepPlugin]);
const security = Object.freeze([semgrepPlugin, trivyPlugin, qualityGatePlugin]);
const devops = Object.freeze([actPlugin, dockerPlugin, k6Plugin]);
const media = Object.freeze([ffmpegPlugin]);
const full = Object.freeze([
  astGrepPlugin,
  ruffPlugin,
  biomePlugin,
  uvPlugin,
  actPlugin,
  semgrepPlugin,
  trivyPlugin,
  dockerPlugin,
  k6Plugin,
  ffmpegPlugin,
  qualityGatePlugin,
]);

export const PRESETS: readonly Preset[] = Object.freeze([
  Object.freeze({
    name: "coding",
    description:
      "General-purpose coding: search/rewrite (ast-grep), Python lint/fix (Ruff), JS/TS/JSX/TSX lint+format (Biome)",
    plugins: coding,
  }),
  Object.freeze({
    name: "python",
    description:
      "Python development: lint/fix/format (Ruff) and environment/dependency management (uv)",
    plugins: python,
  }),
  Object.freeze({
    name: "web",
    description:
      "Web development: JS/TS/JSX/TSX lint+format (Biome) and search/rewrite (ast-grep)",
    plugins: web,
  }),
  Object.freeze({
    name: "security",
    description:
      "Security scanning: code audit (Semgrep), container/IaC/secrets (Trivy), and the quality/security gate",
    plugins: security,
  }),
  Object.freeze({
    name: "devops",
    description:
      "DevOps toolchain: GitHub Actions runner (act), containers (Docker), and load testing (k6)",
    plugins: devops,
  }),
  Object.freeze({
    name: "media",
    description:
      "Media processing: probe, clip, transcode, concat, audio, thumbnail and compress (FFmpeg)",
    plugins: media,
  }),
  Object.freeze({
    name: "full",
    description:
      "Every plugin: ast-grep, Ruff, Biome, uv, act, Semgrep, Trivy, Docker, k6, FFmpeg and the quality gate",
    plugins: full,
  }),
]);

/** Resolve a preset by name; undefined when the preset is unknown. */
export function resolvePreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/**
 * Validate a preset: every plugin is a registered plugin package (non-empty
 * name matching @dsh-forge/plugin-*), targets the current core contract, and
 * no plugin or tool is registered twice. Returns { ok:false } with a reason
 * instead of throwing, so callers can surface the error canonically.
 */
export function validatePreset(
  preset: Preset,
): { ok: true } | { ok: false; error: string } {
  const pluginNames = new Set<string>();
  const toolNames = new Set<string>();
  for (const plugin of preset.plugins) {
    if (!plugin.metadata?.name) {
      return { ok: false, error: "plugin missing metadata.name" };
    }
    if (!plugin.metadata.name.startsWith("@dsh-forge/plugin-")) {
      return {
        ok: false,
        error: `not a registered plugin package: ${plugin.metadata.name}`,
      };
    }
    if (pluginNames.has(plugin.metadata.name)) {
      return {
        ok: false,
        error: `duplicate plugin registration: ${plugin.metadata.name}`,
      };
    }
    pluginNames.add(plugin.metadata.name);
    if (plugin.metadata.coreContractVersion !== CORE_VERSION) {
      return {
        ok: false,
        error: `${plugin.metadata.name}: core contract ${plugin.metadata.coreContractVersion} != ${CORE_VERSION}`,
      };
    }
    if (!Array.isArray(plugin.tools)) {
      return {
        ok: false,
        error: `${plugin.metadata.name}: tools must be an array`,
      };
    }
    for (const tool of plugin.tools) {
      if (toolNames.has(tool.name)) {
        return {
          ok: false,
          error: `duplicate tool registration: ${tool.name}`,
        };
      }
      toolNames.add(tool.name);
    }
  }
  return { ok: true };
}

/** Resolve a preset by name, validating it; throws on unknown/invalid. */
export function resolvePresetOrThrow(name: string): Preset {
  const preset = resolvePreset(name);
  if (!preset) throw new Error(`unknown preset: ${name}`);
  const validation = validatePreset(preset);
  if (!validation.ok) {
    throw new Error(`invalid preset ${name}: ${validation.error}`);
  }
  return preset;
}

/** Flatten a preset's tool names in registration order (unique). */
export function presetToolNames(preset: Preset): readonly string[] {
  return preset.plugins.flatMap((p) => p.tools.map((t) => t.name));
}
