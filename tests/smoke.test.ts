import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "@dsh-forge/core";

describe("workspace smoke", () => {
  it("resolves the core package and exports its version", () => {
    expect(CORE_VERSION).toBe("0.2.0");
  });
});
