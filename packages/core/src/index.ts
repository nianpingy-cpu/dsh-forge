/**
 * Semantic version of the @dsh-forge/core package.
 *
 * Plugins should report this version in their compatibility metadata so the
 * DeepSeek Harness host can reason about which core contract a plugin targets.
 */
export const CORE_VERSION = "1.0.0" as const;

export * from "./process/runner.js";
export * from "./diagnostics/types.js";
export * from "./workspace/policy.js";
export * from "./plugin/types.js";
export * from "./testing/kit.js";
