# Review — reviewer-a

- Verdict: **approve**
- Confidence: 0.75

## Blocking
(none)

## Non-blocking
- Header-less CSV (and JSON 2D-array) data silently treats row 0 as a header, dropping the first record from all stats and using its values as column names. For a tool whose purpose is analyzing client CSVs this can present subtly wrong results as correct; document the header assumption or add a hasHeader/autodetect option. (packages/plugin-vision/scripts/vision-worker.mjs:701)
- vision_inspect trusts header-declared dimensions: a ~33-byte crafted PNG claiming width=0xFFFFFFFF,height=1 returns ok:true with absurd dimensions (extreme-aspect-ratio diagnostic) instead of a parse error. Sanity-check width*height*bpp against file size. (packages/plugin-vision/scripts/vision-worker.mjs:251)
- imageDiagnostics contains a dead !parsed.ok branch — cmdInspect returns parse failures directly, so the 'unrecognized-format' diagnostic is never emitted. Harmless but misleading. (packages/plugin-vision/scripts/vision-worker.mjs:437)
- data_analyze memory is bounded only by the 64 MiB input cap and timeout: a wide CSV (many cells of short strings) can drive the worker toward multi-GB heap and OOM-kill, surfacing as a generic ToolFailure. Consider a row/column-count cap in addition to the byte cap. (packages/plugin-vision/scripts/vision-worker.mjs:548)
- chart_generate on a data file with >2000 plottable rows returns InvalidArguments ('too many data points'), a misleading code for a valid file; the constraint is documented nowhere in the tool schema. (packages/plugin-vision/scripts/vision-worker.mjs:978)
- toNumberValue misparses EU decimal commas ('1,5' -> 15) and hex strings ('0x1F' -> 31), and strips %/currency globally; acceptable for heuristics but worth documenting. (packages/plugin-vision/scripts/vision-worker.mjs:109)
- BMP width is read as signed and never abs'd/validated, so a crafted negative-width BMP yields negative width/aspect-ratio in results. (packages/plugin-vision/scripts/vision-worker.mjs:393)
- Empty-file analyze returns ok:true with rows:0 and an error-severity empty-data diagnostic — a successful ToolResult carrying an error-severity finding is a semantic oddity for model-facing rendering. (packages/plugin-vision/scripts/vision-worker.mjs:681)
- parseWorker maps exec.aborted to Timeout and treats stderr overflow as the stdout '8 MiB output cap' message; mislabels are minor since no AbortSignal is passed and stderr is normally empty. (packages/plugin-vision/src/index.ts:160)
- series schema items:{type:'object'} are not shape-validated; a model passing [{foo:1}] passes schema validation and gets a confusing 'no plottable pairs' InvalidArguments instead of a helpful message. (packages/plugin-vision/src/index.ts:506)
- Output write remains a TOCTOU by design: the worker writes to the canonical absolute path with 'w' on overwrite and never re-validates containment. Pre-existing symlink escapes are rejected by resolveInWorkspace, so only concurrent workspace mutation triggers this; passing workspaceRoot to the worker for a final check would close it. (packages/plugin-vision/scripts/vision-worker.mjs:1001)

## Security
- No command injection, no shell, typed argv, leading-dash/control-char rejection, random UUID sentinel for missing worker — all verified. Residual concerns are defense-in-depth: (1) the output-write TOCTOU above; (2) worker echoes full cell values (string 'top', min/max) back into results — inherent to the tool but sensitive cells can reach the model; (3) the pre-spawn existsSync worker check has a tiny delete-between-check-and-spawn window that would degrade to ParseFailure rather than BinaryNotFound. (packages/plugin-vision/src/index.ts:109)
- Env allowlist is load-bearing and now has a test; verified against core runProcess which always applies DEFAULT_ENV_ALLOWLIST when env is omitted. No secrets reach the worker. (packages/plugin-vision/tests/vision.test.ts:343)

## Test gaps
- No tests for successful JPEG/WebP/GIF/BMP dimension parsing — only truncated-header failures; the format parsers are otherwise unexercised.
- No tests for the Timeout, truncated-output, exitCode-null, or worker-error-document paths in runWorker/parseWorker (mock runners cover ok/BinaryNotFound/malformed only).
- No test for chart_generate reading a JSON data file (only CSV).
- No test for >64 MiB input rejection or FIFO/device/directory rejection in resolveInput.
- No concurrency test for the wx create-exclusive guard (two overlapping writes to one output).
- vision-missing-worker.test.ts claims real-runner coverage but the pre-spawn existsSync short-circuit means the process runner is never invoked; the ENOENT/empty-stdout path is untested.
- No test that the built dist entry resolves scripts/vision-worker.mjs when consumed as an installed package (main/types point to src/index.ts while files ships dist/scripts).

## Compatibility
- DeepSeek Harness manifest still flags the real permission-hook API as TBD; the plugin's ctx.permission ?? {approved:false} default fails safe (denies), and assertPermission semantics match core's PermissionContext shape.
- main/types pointing at src/index.ts with files shipping dist/scripts is consistent with plugin-biome, but the vision worker path resolution is load-bearing and unverified for a built-package consumer.
- Worker relies on Node zlib maxOutputLength (>=12.19) and randomUUID — fine for the stated >=22.19 requirement.

## Architecture
- Binary detection is reimplemented in-plugin (resolveVisionWorker + random sentinel) rather than delegated to a shared core helper, contrary to the plugin standard's 'no infrastructure duplication'; worth centralizing if repeated across plugins.
- Boundary enforcement is split across layers: the plugin validates/canonicalizes and the worker blindly writes to the given absolute path without knowing the workspace root; a core-owned write primitive would be more robust.
- Worker error codes (UnsupportedFormat, ParseFailure, InvalidArguments) flatten to ToolError codes via an ad-hoc mapping table in parseWorker that should be documented so future worker codes don't silently lose meaning.
