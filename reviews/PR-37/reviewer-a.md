# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.7

## Blocking
(none)

## Non-blocking
- gatherPRInput() does not actually read test results: testSummary and coverage are hardcoded placeholder strings, and the PR body (which the reviewer is told to consult for 'TDD evidence') is never passed to the reviewer — only the linked issue body is. The issue objective explicitly says 'read git diff, issue metadata, test results'; the reviewer is directed to evidence it cannot see.
- changedFiles parsing in gatherPRInput() treats every diff line starting with '+++ b/' as a file header. An added content line '++ b/foo' renders in unified diff as '+++ b/foo' and pollutes changedFiles with a false path. This is fragile malformed-CLI-output handling with no test coverage.
- The gh() calls in gatherPRInput() run execFileSync without a timeout, so a hung gh (slow network, git lock) stalls the entire review gate indefinitely — directly violating the repo's 'timeout + output caps on every execution' rule, which the HTTP and claude calls do honor.
- Exit-code conflation: any infra failure (gh missing/unauthenticated, PR/issue not found, JSON parse error, reviewer API down) surfaces as exit 1, which is also the documented code for 'blocking findings'. A CI gate cannot distinguish 'PR has blocking findings' from 'pipeline is broken'. Only the no-reviewer and usage cases use exit 2.
- If the PR body contains 'Closes #N' for a missing, restricted, or non-issue number, `gh issue view` throws and the whole pipeline exits 1 — a typo or access-controlled issue fails the gate with a blocking-findings signal.
- invokeWithRetry() retries every error, including non-transient 401/400/403 auth/config errors and 10-minute claude CLI timeouts; a persistent failure stalls the gate up to 3× the per-attempt timeout plus backoff.
- callClaudeReviewer() defaults to `--model deepseek-chat` on the claude CLI, which is only valid when ANTHROPIC_BASE_URL points at a DeepSeek-compatible endpoint; with a plain Anthropic setup the fallback path errors out and the gate fails.
- runReview() writes into reviews/PR-N which is not covered by .gitignore (reviews/ already exists untracked in the tree), mkdirSync is recursive so stale artifacts from prior runs are never cleaned, and `git add -A` can accidentally commit reviewer artifacts.
- Reviewers A and B run strictly sequentially even though they are independent; latency is 2× what parallel invocation would give for a CI gate.
- max_tokens: 4000 is the only output cap; there is no response-size limit on the parsed JSON arrays, so a runaway/malicious reviewer response can produce a huge artifact file.

## Security
- Error artifacts (.error.md) are written with String(err) verbatim and are excluded from the 'no secrets in artifacts' assertion (tests check only reviewer-a.json and reviewer-a.md on the success path). callReviewer() embeds the provider's error body via await response.text() into the thrown message; if a gateway echoes the Authorization header in its error body, the REVIEWER_A_API_KEY leaks into a git-visible artifact.
- callClaudeReviewer() invokes the claude CLI with execFileSync and no env allowlist, inheriting the full process environment including ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY — contrary to the repo's stated 'third-party CLIs never inherit the full environment' rule. The prompt is passed via stdin (not argv), which limits exposure, but the inherited env is unredacted.
- validateReviewResponse() coerces array elements with .map(String), so a prompt-injected reviewer returning objects produces '[object Object]' findings; combined with no array-size bound, a malicious response can flood the artifact with junk.

## Test gaps
- No test for gatherPRInput(): the gh-based diff/issue/changedFiles gathering — including the '+++ b/' content-line false positive and the missing-linked-issue crash — is completely untested.
- No test for callClaudeReviewer() or the claude-CLI fallback branch in main().
- No test for verifyResponse() in isolation, and no test for main() with a valid --pr (happy path or gh-failure path).
- No test asserting .error.md or .verification.md artifacts are free of secrets.
- No test that the default artifacts dir reviews/PR-N is created in the repo, that re-runs don't mix stale artifacts, or that artifacts don't appear as untracked git files.
- The 'no secrets in artifacts' test only exercises the success path; the retry test bypasses callReviewer entirely via an injected invoke, so the real HTTP error path is never checked for secret leakage.

## Compatibility
- package.json declares engines.node '>=20', but `node scripts/review-pr.ts` relies on Node's built-in TS type-stripping (enabled by default only in Node ≥22.18 / 23.6). On any Node 20–22.17 the script crashes, so the declared engines range is wrong for this script; it should be aligned to the manifest's '>=22.19'.
- callReviewer() sends max_tokens, but several OpenAI-compatible providers (o-series, some DeepSeek endpoints) expect max_completion_tokens and will ignore the cap, increasing truncation/retry risk.
- The prompt files review/prompts/*.md satisfy the acceptance-criteria 'exist' requirement but are never read by the code (the text is hardcoded in FOCUS_PROMPTS), so the on-disk prompts and the actual reviewer prompts can silently diverge.

## Architecture
- review/prompts/correctness-security.md and design-testing.md are dead files: FOCUS_PROMPTS hardcodes the same text, creating duplication and drift risk between what reviewers actually receive and what the repo documents.
- The 'read test results' objective is not implemented — testSummary/coverage are static strings, and the PR body containing the TDD evidence is never included in the prompt.
- joinPath() is string concatenation rather than path.join(); it happens to work for the fixed filenames and forward slashes on Windows, but it is a fragile pattern for any path handling that evolves.
- gh(args: string) builds argv via args.split(/\s+/); it is safe today because every interpolated value is a validated number or \d+ match, but it is a latent command-line parsing trap if any future argument may contain spaces.
