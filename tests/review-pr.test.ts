import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewPrompt,
  validateReviewResponse,
  callReviewer,
  runReview,
  type ReviewInput,
  type ReviewResponse,
  type ReviewerConfig,
} from "../scripts/review-pr";

const validResponse: ReviewResponse = {
  verdict: "approve",
  blocking: [],
  non_blocking: ["consider renaming x"],
  security: [],
  test_gaps: [],
  compatibility: [],
  architecture: [],
  confidence: 0.9,
};

function makeInput(): ReviewInput {
  return {
    prNumber: 12,
    issue: { title: "ISSUE-004: Core process runner", body: "## Objective\nImplement runner", labels: ["type:infra"] },
    baseCommit: "abc123",
    headCommit: "def456",
    diff: "+ function runProcess() {}",
    changedFiles: ["packages/core/src/process/runner.ts"],
    testSummary: "26/26 passed, typecheck clean",
    coverage: "n/a",
    architectureRules: "ADR-004: no shell:true",
    securityRules: "env allowlist required",
    compatibilityManifest: { repository: "deepseek-ai/deepseek-harness", commit: "47f943859bef60e4160492346772ded9b24f765a" },
  };
}

describe("buildReviewPrompt", () => {
  it("includes issue, diff, tests, rules, and compatibility manifest", () => {
    const prompt = buildReviewPrompt(makeInput(), "correctness-security");
    expect(prompt).toContain("ISSUE-004");
    expect(prompt).toContain("runProcess");
    expect(prompt).toContain("26/26 passed");
    expect(prompt).toContain("ADR-004");
    expect(prompt).toContain("47f943859bef60e4160492346772ded9b24f765a");
    expect(prompt).toContain("packages/core/src/process/runner.ts");
  });

  it("embeds the reviewer focus prompt", () => {
    const prompt = buildReviewPrompt(makeInput(), "correctness-security");
    expect(prompt).toContain("command injection");
    const promptB = buildReviewPrompt(makeInput(), "design-testing");
    expect(promptB).toContain("TDD integrity");
  });
});

describe("validateReviewResponse", () => {
  it("accepts a valid response", () => {
    const result = validateReviewResponse(JSON.stringify(validResponse));
    expect(result.ok).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const result = validateReviewResponse("not json {{{");
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid verdict", () => {
    const result = validateReviewResponse(JSON.stringify({ ...validResponse, verdict: "maybe" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing verdict", () => {
    const result = validateReviewResponse(JSON.stringify({ blocking: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects wrong-typed blocking list", () => {
    const result = validateReviewResponse(JSON.stringify({ ...validResponse, blocking: "none" }));
    expect(result.ok).toBe(false);
  });

  it("extracts JSON from a fenced code block", () => {
    const wrapped = "Here is my review:\n```json\n" + JSON.stringify(validResponse) + "\n```";
    const result = validateReviewResponse(wrapped);
    expect(result.ok).toBe(true);
  });
});

describe("callReviewer (mocked API)", () => {
  const config: ReviewerConfig = {
    provider: "openai-compatible",
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "http://mock.local/v1",
  };

  let fetchCalls: { url: string; init: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validResponse) } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the prompt to the chat completions endpoint with the API key header", async () => {
    const response = await callReviewer(config, "review prompt");
    expect(response.verdict).toBe("approve");
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.url).toBe("http://mock.local/v1/chat/completions");
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(fetchCalls[0]?.init.body));
    expect(body.model).toBe("test-model");
    expect(String(body.messages[1].content)).toContain("review prompt");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch;
    await expect(callReviewer(config, "prompt")).rejects.toThrow(/429/);
  });
});

describe("runReview (mocked, artifact writing)", () => {
  const originalFetch = globalThis.fetch;
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), "dsh-review-"));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validResponse) } }],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("writes reviewer JSON and Markdown artifacts without secrets", async () => {
    const exitCode = await runReview(makeInput(), {
      reviewerA: {
        provider: "openai-compatible",
        model: "test-model",
        apiKey: "SUPER-SECRET-KEY-VALUE",
        baseUrl: "http://mock.local/v1",
      },
      artifactsDir,
    });
    expect(exitCode).toBe(0);
    const jsonA = readFileSync(join(artifactsDir, "reviewer-a.json"), "utf8");
    expect(JSON.parse(jsonA).verdict).toBe("approve");
    expect(existsSync(join(artifactsDir, "reviewer-a.md"))).toBe(true);
    // secrets must never appear in artifacts
    for (const f of ["reviewer-a.json", "reviewer-a.md"]) {
      const content = readFileSync(join(artifactsDir, f), "utf8");
      expect(content).not.toContain("SUPER-SECRET-KEY-VALUE");
    }
  });

  it("returns exit code 1 when blocking findings exist", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...validResponse,
                  verdict: "request_changes",
                  blocking: ["path traversal in rewrite tool"],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const exitCode = await runReview(makeInput(), {
      reviewerA: {
        provider: "openai-compatible",
        model: "test-model",
        apiKey: "k",
        baseUrl: "http://mock.local/v1",
      },
      artifactsDir,
    });
    expect(exitCode).toBe(1);
  });

  it("returns exit code 2 when no reviewer is configured", async () => {
    const exitCode = await runReview(makeInput(), { reviewerA: undefined, artifactsDir });
    expect(exitCode).toBe(2);
  });
});
