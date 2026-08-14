/**
 * External model PR review pipeline (ISSUE-008, ADR-006).
 *
 * Builds a review prompt from the issue, diff, tests, rules, and the DSH
 * compatibility manifest; calls configurable external reviewers; validates
 * the structured JSON response; writes artifacts under reviews/PR-N/; exits
 * non-zero on blocking findings. CI unit tests use mocked fetch only.
 */

export interface ReviewInput {
  prNumber: number;
  issue: { title: string; body: string; labels: string[] };
  baseCommit: string;
  headCommit: string;
  /** Commit history between base and head, newest-first: "shortsha subject". */
  commits: string[];
  diff: string;
  changedFiles: string[];
  testSummary: string;
  coverage: string;
  architectureRules: string;
  securityRules: string;
  compatibilityManifest: Record<string, unknown>;
}

export type ReviewFocus = "correctness-security" | "design-testing";

export interface ReviewResponse {
  verdict: "approve" | "request_changes";
  blocking: string[];
  non_blocking: string[];
  security: string[];
  test_gaps: string[];
  compatibility: string[];
  architecture: string[];
  confidence: number;
}

export interface ReviewerConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

const FOCUS_PROMPTS: Record<ReviewFocus, string> = {
  "correctness-security": `You are an independent senior software engineer reviewing a pull request.

You did NOT implement this code.

Review the PR adversarially.

Focus on:
1. correctness
2. security
3. command injection
4. path traversal
5. unsafe subprocess execution
6. unsafe filesystem mutation
7. permission bypass
8. timeout/resource handling
9. malformed CLI output
10. concurrency
11. error handling
12. cross-platform behavior
13. DeepSeek Harness compatibility
14. missing tests

Do not praise the implementation.
Do not rewrite the entire PR.
Identify concrete problems.
Only mark something blocking if it should prevent merge.
Return valid JSON following the provided schema.`,
  "design-testing": `You are an independent maintainer reviewing a pull request.

Focus on:
1. TDD integrity
2. whether tests actually prove behavior
3. regression risk
4. public API quality
5. abstraction boundaries
6. duplication
7. maintainability
8. package architecture
9. documentation
10. DeepSeek Harness integration
11. backward compatibility
12. unnecessary complexity

Look specifically for implementation written before meaningful tests,
tests that merely mirror the implementation,
and abstractions introduced too early.

Return valid JSON following the provided schema.`,
};

const RESPONSE_SCHEMA = `{
  "verdict": "approve|request_changes",
  "blocking": [],
  "non_blocking": [],
  "security": [],
  "test_gaps": [],
  "compatibility": [],
  "architecture": [],
  "confidence": 0.0
}`;

/** Build the full review prompt: focus + context + schema. */
export function buildReviewPrompt(input: ReviewInput, focus: ReviewFocus): string {
  return [
    FOCUS_PROMPTS[focus],
    "",
    "## Issue",
    `Title: ${input.issue.title}`,
    `Labels: ${input.issue.labels.join(", ")}`,
    input.issue.body,
    "",
    "## Commits",
    `base: ${input.baseCommit}`,
    `head: ${input.headCommit}`,
    input.commits.length > 0
      ? input.commits.join("\n")
      : "(commit history unavailable)",
    "",
    "## Changed files",
    input.changedFiles.join("\n"),
    "",
    "## Test results",
    input.testSummary,
    `Coverage: ${input.coverage}`,
    "",
    "## Architecture rules",
    input.architectureRules,
    "",
    "## Security rules",
    input.securityRules,
    "",
    "## DeepSeek Harness compatibility manifest",
    JSON.stringify(input.compatibilityManifest, null, 2),
    "",
    "## PR diff",
    "```diff",
    input.diff,
    "```",
    "",
    "Respond with ONLY a JSON object (optionally inside a ```json fence) matching:",
    "```json",
    RESPONSE_SCHEMA,
    "```",
  ].join("\n");
}

export type ValidationOutcome =
  | { ok: true; value: ReviewResponse }
  | { ok: false; error: string };

/** Render a finding entry as a readable string, preserving nested objects. */
function stringifyFinding(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "(empty finding)";
  // Prefer common human-readable fields, then fall back to full JSON so no
  // information is lost (never collapse to "[object Object]").
  if (typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const preferred =
      record.issue ?? record.finding ?? record.description ?? record.message ?? record.suggestion;
    if (typeof preferred === "string" && preferred.trim() !== "") {
      const context = { ...record };
      delete context.issue;
      delete context.finding;
      delete context.description;
      delete context.message;
      delete context.suggestion;
      const rest = Object.entries(context);
      if (rest.length > 0) {
        return `${preferred} (${rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`;
      }
      return preferred;
    }
    return JSON.stringify(entry);
  }
  return String(entry);
}

/** Validate/extract a reviewer's JSON response. */
export function validateReviewResponse(text: string): ValidationOutcome {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: "no JSON object found in response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${String(err)}` };
  }
  const r = parsed as Record<string, unknown>;
  if (r.verdict !== "approve" && r.verdict !== "request_changes") {
    return {
      ok: false,
      error: `verdict must be "approve" or "request_changes", got ${String(r.verdict)}`,
    };
  }
  for (const field of ["blocking", "non_blocking", "security", "test_gaps", "compatibility", "architecture"]) {
    if (!Array.isArray(r[field])) {
      return { ok: false, error: `${field} must be an array of strings` };
    }
  }
  return {
    ok: true,
    value: {
      verdict: r.verdict,
      blocking: (r.blocking as unknown[]).map(stringifyFinding),
      non_blocking: (r.non_blocking as unknown[]).map(stringifyFinding),
      security: (r.security as unknown[]).map(stringifyFinding),
      test_gaps: (r.test_gaps as unknown[]).map(stringifyFinding),
      compatibility: (r.compatibility as unknown[]).map(stringifyFinding),
      architecture: (r.architecture as unknown[]).map(stringifyFinding),
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    },
  };
}

/** Call one reviewer via an OpenAI-compatible chat completions endpoint. */
export async function callReviewer(
  config: ReviewerConfig,
  prompt: string,
): Promise<ReviewResponse> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "You are a code reviewer. Respond only with JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`reviewer API error ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const validated = validateReviewResponse(content);
  if (!validated.ok) {
    throw new Error(`reviewer returned an invalid response: ${validated.error}`);
  }
  return validated.value;
}

export interface RunReviewOptions {
  reviewerA?: ReviewerConfig;
  reviewerB?: ReviewerConfig;
  artifactsDir: string;
  /** Injectable for tests; defaults to callReviewer. */
  invoke?: (config: ReviewerConfig, prompt: string) => Promise<ReviewResponse>;
}

function toMarkdown(reviewer: string, response: ReviewResponse): string {
  const lines = [
    `# Review — ${reviewer}`,
    "",
    `- Verdict: **${response.verdict}**`,
    `- Confidence: ${response.confidence}`,
    "",
  ];
  const sections: [string, string[]][] = [
    ["Blocking", response.blocking],
    ["Non-blocking", response.non_blocking],
    ["Security", response.security],
    ["Test gaps", response.test_gaps],
    ["Compatibility", response.compatibility],
    ["Architecture", response.architecture],
  ];
  for (const [title, items] of sections) {
    lines.push(`## ${title}`);
    if (items.length === 0) lines.push("(none)");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Run the review pipeline. Returns process exit code:
 * 0 = approved (no blocking findings), 1 = blocking findings, 2 = no reviewer.
 */
export async function runReview(
  input: ReviewInput,
  options: RunReviewOptions,
): Promise<number> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const invoke = options.invoke ?? callReviewer;
  mkdirSync(options.artifactsDir, { recursive: true });

  if (!options.reviewerA) {
    writeFileSync(
      joinPath(options.artifactsDir, "blocked.md"),
      "# BLOCKED\n\nNo external reviewer configured. Set REVIEWER_A_* environment variables.\n",
    );
    return 2;
  }

  let worstExit = 0;
  const reviewers: [string, ReviewerConfig, ReviewFocus][] = [];
  if (options.reviewerA) {
    reviewers.push(["reviewer-a", options.reviewerA, "correctness-security"]);
  }
  if (options.reviewerB) {
    reviewers.push(["reviewer-b", options.reviewerB, "design-testing"]);
  }

  for (const [name, config, focus] of reviewers) {
    const prompt = buildReviewPrompt(input, focus);
    let response: ReviewResponse;
    try {
      response = await invoke(config, prompt);
    } catch (err) {
      writeFileSync(
        joinPath(options.artifactsDir, `${name}.error.md`),
        `# Reviewer error\n\n${String(err)}\n`,
      );
      worstExit = Math.max(worstExit, 1);
      continue;
    }
    writeFileSync(
      joinPath(options.artifactsDir, `${name}.json`),
      JSON.stringify(response, null, 2),
    );
    writeFileSync(
      joinPath(options.artifactsDir, `${name}.md`),
      toMarkdown(name, response),
    );
    if (response.blocking.length > 0 || response.verdict === "request_changes") {
      worstExit = Math.max(worstExit, 1);
    }
  }
  return worstExit;
}

function joinPath(dir: string, file: string): string {
  return `${dir.replace(/\/$/, "")}/${file}`;
}

/** Read reviewer config from environment variables. */
export function reviewerConfigFromEnv(
  prefix: "REVIEWER_A" | "REVIEWER_B",
): ReviewerConfig | undefined {
  const provider = process.env[`${prefix}_PROVIDER`];
  const model = process.env[`${prefix}_MODEL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!provider || !model || !apiKey || !baseUrl) return undefined;
  return { provider, model, apiKey, baseUrl };
}
