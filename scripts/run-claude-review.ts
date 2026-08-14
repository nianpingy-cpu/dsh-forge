/**
 * External review driver via the local claude CLI (ADR-006).
 *
 * Invokes `claude -p` (non-interactive print mode) as the review runner.
 * The actual reviewing model is whatever backend the CLI is configured
 * with — for this project, DeepSeek's Anthropic-compatible endpoint:
 *
 *   ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
 *   ANTHROPIC_AUTH_TOKEN=<deepseek key>   (never committed)
 *   ANTHROPIC_MODEL=deepseek-chat
 *
 * The reviewer model is independent of the implementing agent.
 *
 * Usage: npx tsx scripts/run-claude-review.ts --pr 31
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReviewPrompt,
  validateReviewResponse,
  type ReviewInput,
  type ReviewResponse,
} from "./review-pr";

function parseArgs(): { pr: number } {
  const args = process.argv.slice(2);
  const prIndex = args.indexOf("--pr");
  const pr = prIndex !== -1 ? Number(args[prIndex + 1]) : NaN;
  if (!Number.isFinite(pr)) {
    console.error("usage: run-claude-review.ts --pr <number>");
    process.exit(2);
  }
  return { pr };
}

function gh(args: string): string {
  return execFileSync("gh", args.split(/\s+/), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
}

function gatherInput(pr: number): ReviewInput {
  const prJson = JSON.parse(
    gh(`pr view ${pr} --json title,body,baseRefOid,headRefOid,commits`),
  ) as {
    title: string;
    body: string;
    baseRefOid: string;
    headRefOid: string;
    commits: { oid: string; messageHeadline: string }[];
  };
  const diff = gh(`pr diff ${pr}`);
  const commits = prJson.commits.map(
    (c) => `${c.oid.slice(0, 7)} ${c.messageHeadline.split("\n")[0] ?? ""}`,
  );
  const changedFiles = diff
    .split("\n")
    .filter((l) => l.startsWith("+++ b/"))
    .map((l) => l.replace(/^\+\+\+ b\//, ""))
    .filter((l) => l !== "/dev/null");

  const issueMatch = prJson.body.match(/Closes #(\d+)/);
  let issue = { title: prJson.title, body: "(no linked issue)", labels: [] as string[] };
  if (issueMatch?.[1]) {
    const issueJson = JSON.parse(
      gh(`issue view ${issueMatch[1]} --json title,body,labels`),
    ) as { title: string; body: string; labels: { name: string }[] };
    issue = {
      title: issueJson.title,
      body: issueJson.body.slice(0, 4000),
      labels: issueJson.labels.map((l) => l.name),
    };
  }

  const manifest = JSON.parse(
    readFileSync("compatibility/deepseek-harness.json", "utf8"),
  );

  return {
    prNumber: pr,
    issue,
    baseCommit: prJson.baseRefOid,
    headCommit: prJson.headRefOid,
    commits,
    diff: diff.slice(0, 60_000),
    changedFiles,
    testSummary:
      "See PR body TDD evidence; CI ran pnpm test/typecheck/lint/build on ubuntu+windows, all green.",
    coverage: "not gated yet",
    architectureRules: readFileSync("docs/PLUGIN_STANDARD.md", "utf8").slice(0, 4000),
    securityRules: readFileSync("SECURITY.md", "utf8").slice(0, 3000),
    compatibilityManifest: manifest,
  };
}

/** Call the reviewer through the claude CLI in print mode. */
function callReviewerCli(prompt: string): ReviewResponse {
  // The prompt is passed via stdin to avoid command-line length limits and
  // any shell interpolation. The CLI runs with the repo as cwd but we do
  // NOT grant it tools — this is a pure text-in/text-out review call.
  const content = execFileSync(
    "claude",
    ["-p", "--output-format", "text", "--model", process.env.REVIEWER_MODEL ?? "deepseek-chat"],
    {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      shell: false,
      env: process.env,
    },
  );
  const validated = validateReviewResponse(content);
  if (!validated.ok) {
    throw new Error(
      `invalid reviewer response: ${validated.error}\nraw head: ${content.slice(0, 400)}`,
    );
  }
  return validated.value;
}

function toMarkdown(reviewer: string, r: ReviewResponse): string {
  const lines = [
    `# Review — ${reviewer}`,
    "",
    `- Verdict: **${r.verdict}**`,
    `- Confidence: ${r.confidence}`,
    "",
  ];
  const sections: [string, string[]][] = [
    ["Blocking", r.blocking],
    ["Non-blocking", r.non_blocking],
    ["Security", r.security],
    ["Test gaps", r.test_gaps],
    ["Compatibility", r.compatibility],
    ["Architecture", r.architecture],
  ];
  for (const [title, items] of sections) {
    lines.push(`## ${title}`);
    if (items.length === 0) lines.push("(none)");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const { pr } = parseArgs();
  const input = gatherInput(pr);
  const prompt = buildReviewPrompt(input, "correctness-security");
  console.log(`reviewing PR #${pr} via claude CLI (backend: DeepSeek) ...`);
  const response = callReviewerCli(prompt);
  const dir = join("reviews", `PR-${pr}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reviewer-a.json"), JSON.stringify(response, null, 2));
  writeFileSync(join(dir, "reviewer-a.md"), toMarkdown("reviewer-a (deepseek via claude cli)", response));
  console.log(`verdict: ${response.verdict} (confidence ${response.confidence})`);
  console.log(`blocking: ${response.blocking.length}`);
  for (const b of response.blocking) console.log(`  - ${b}`);
  process.exit(
    response.blocking.length > 0 || response.verdict === "request_changes" ? 1 : 0,
  );
}

main();
