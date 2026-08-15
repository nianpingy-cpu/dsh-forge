import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "@dsh-forge/core";
import {
  PRESETS,
  resolvePreset,
  resolvePresetOrThrow,
  presetToolNames,
} from "@dsh-forge/presets";

describe("presets (V0.1.0: coding, python, web)", () => {
  it("defines exactly the V0.2.0 preset set", () => {
    const names = PRESETS.map((p) => p.name).sort();
    expect(names).toEqual([
      "coding",
      "devops",
      "python",
      "security",
      "web",
    ]);
  });

  it("each preset resolves to registered, valid, contract-aligned plugins", () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.plugins.length).toBeGreaterThan(0);
      for (const plugin of preset.plugins) {
        expect(plugin.metadata.name).toMatch(/^@dsh-forge\/plugin-/);
        expect(plugin.metadata.coreContractVersion).toBe(CORE_VERSION);
        expect(plugin.tools.length).toBeGreaterThan(0);
        const toolNames = new Set(plugin.tools.map((t) => t.name));
        expect(toolNames.size).toBe(plugin.tools.length);
      }
    }
  });

  it("resolvePreset returns the manifest by name; unknown preset fails", () => {
    expect(resolvePreset("coding")?.name).toBe("coding");
    expect(resolvePreset("python")?.name).toBe("python");
    expect(resolvePreset("web")?.name).toBe("web");
    expect(resolvePreset("security")?.name).toBe("security");
    expect(resolvePreset("devops")?.name).toBe("devops");
    expect(resolvePreset("does-not-exist")).toBeUndefined();
    expect(() => resolvePresetOrThrow("does-not-exist")).toThrow(/unknown preset/i);
  });

  it("registers no duplicate tool names across a preset", () => {
    for (const preset of PRESETS) {
      const toolNames = presetToolNames(preset);
      expect(toolNames.length).toBeGreaterThan(0);
      expect(new Set(toolNames).size).toBe(toolNames.length);
    }
  });
});
