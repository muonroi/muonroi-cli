# Main reads evidence and distinguishes partial work from completion

Current update: the user requested internal evidence receipts hidden. Main retains the read tools and internal completion facts, but assistant receipt emission/persistence is removed and exact historical receipt suffixes are hidden in display. The receipt behavior described below is the initial implementation, superseded by [the current update](session-4edc02516a92-worker-schema.md).

The user identified coordinator scope overstatement in session `4edc02516a92`: the coordinator explicitly retracted a whole-task completion claim, admitted only corpus preflight existed, and said main reading the plan would destroy independent verification. The quoted report is stored at assistant seq697 (`2026-11-04T01:23:01.528Z`). The inspected MCP package snapshot had no `.cs` or `.csproj` deliverables. These are historical observations, not a statement about concurrent consumer work after inspection.

The native main allowlist excluded `read_file` and `grep`. Its contract, progressive context, native capability reference and skill guidance all delegated source/plan inspection. A negative test confirmed that filtering removed those exact native tools.

## Current change

- Main now receives exact trusted native `read_file` and `grep` objects after tool merging. Fake replacements, MCP aliases, bash, writes and test execution remain outside main's allowed inventory. Worker and independent review role boundaries remain in force.
- Main reads the current plan, applicable skills, source, logs and saved evidence in bounded sections. It retains the full user goal, completed partial scope, evidence references, remaining deliverables and next action through the existing working ledger/handoff and all three compaction prompts. Implementation, commands/tests and independent acceptance still require their existing worker paths. Reading evidence does not replace a separately bound reviewer.
- New main reads use existing SDK/UI approval requests in safe mode. Actual SDK tests prove neither file contents nor grep matches reach the model before approval. Auto-edit and yolo reads execute normally.
- `flow_status.completion` distinguishes the declared plan heading, recorded plan-review verdict and missing/unstructured/recorded-pass/recorded-fail implementation verification. A nonempty narrative verification file is not a recorded verdict. The existing admission gates are unchanged.
- Main's actual prepared requests receive this artifact boundary only after its own session family or completed native Flow tool result establishes workflow usage. Merely reading a different conversation's plan does not establish usage. The normal successful final path persists a code-authored evidence receipt alongside model prose. The SDK completion callback handles the race where the next request starts before fullStream tool calls reach SQLite.

The receipt always leaves whole-task completion unverified: neither recorded metadata nor a plan heading proves acceptance coverage or freshness. The controlled model deliberately still says "All requested work is complete"; the test proves the host exposes the missing implementation verification alongside it, not that arbitrary generated claims are semantically prevented. Error fallback paths and adoption by the existing live consumer host are not certified by this change. No extra paid model request or natural-language completion detector was added.

## Verification

Owner run and raw logs: `.quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/runs/completion-scope.md`.

- RED: native main read tools were filtered out; fresh Flow ownership context was absent at the next SDK step. Separate safe-mode RED showed that exposing reads without SDK approval metadata did not request consent.
- Final focused regression: **124 tests / 18 files passed**, exit0 (`completion-regression.log`). Includes real Agent + SDK mock reads/searches, safe-mode nonexecution for each tool, yolo/auto-edit reads, current-turn and subsequent-turn workflow ownership, unrelated-conversation isolation, missing/unstructured/pass/fail evidence, role/alias boundaries, context references, compaction and workflow regressions. Models are fixtures; these tests do not establish live-provider reliability.
- `bun run typecheck` passed; final `bun run build` passed and includes TypeScript compilation (`completion-typecheck.log`, `completion-build.log`).
- The separately installed MCP endpoint failed before QA with missing `@muonroi/agent-harness-core/selector`; it is not a passing test. The rebuilt workspace's native selfverify endpoint passed **smoke-boot 1/1**, run `e52edaac-85fc-4cdc-bf29-b4a8a0814a9f` (`completion-selfverify-report.json`). Boot QA does not exercise semantic completion claims; SDK tests cover the named behavior.
- Installed-global and workspace compiled policy, tool engine and completion helper SHA-256 hashes match. An already loaded Bun host still requires reopening/resuming to adopt the change.

No commit, push, paid council/verifier call, live restart, consumer PLAN edit or gate modification was performed. This is CLI control/evidence work; it does not implement the TCIS MCP server.
