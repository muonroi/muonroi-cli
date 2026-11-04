# Runtime context and tool follow-through

Completed the actionable follow-up to [session a0440cf44684](session-a0440cf44684-runtime-feedback-2026-10-16.md), following the [earlier contract fix](a044-tool-contract-clarity-2026-10-16.md). Changes are in the local working tree and rebuilt package, with unrelated WIP preserved.

## Implemented behavior

| Area | Result | Boundary |
|---|---|---|
| Progressive guidance | Current-turn successful native reads select research, applied edits select implement, successful verification selects verify. Main and child SDK steps project the latest guidance. | No shell-text/intent guessing, forced pipeline or permission/GSD unlock. Failed/blocked calls do not select stages. Explicit context_load pins the chosen stage; cwd changes reset it. New tasks retain existing reset/continuation rules. |
| Schema visibility | Prepared-request records include numeric per-tool name/description/input-schema character counts and token estimates, plus native/MCP totals and stage-selection origin. | No schema or prompt bodies are persisted by this measurement. Origin uses the mcp_ naming convention, not billing provenance. Forensics shows the largest 5 rows per measurement and the full stored count; historical absent fields remain null. |
| Bounded reads and reuse | read_file supports max_chars; single and batch reads identify unreturned lines and how to continue. Guidance prioritizes sufficient existing excerpts and exact toolCallId retrieval. | No claim that omitted content exists in the transcript. Very long lines require targeted excerpts. Current-content read/hash guards are preserved; no automatic mutation replay or disabled compaction. |
| Edit preview | edit_file(dry_run=true) uses the real containment/read/hash/matching/CRLF/diff path, returning preview=true without writing, changing the write ledger or synchronizing LSP. | Applying is a separate validated edit, not a reservation of file contents. Normalization, persistence, diagnostics and UI retain/label preview provenance; grouped summaries say Previewed, not Edited. Existing edit permission/GSD classification remains. |
| Verification routing | verification_run supports installed local Vitest/Jest/Mocha, explicit JavaScript node:test, and pytest with a workspace .venv interpreter. Both native and external MCP surfaces share the runner and cancellation. | Explicit contained existing test files only, no shell expansion/scripts/downloads. Ambiguous JS installations require runner selection. Other Python environments, build commands and unsupported runners use the repo workflow. Tests can write their ordinary fixtures/cache. |

Source anchors: task-context.ts:70, prompt-breakdown.ts:17, forensics-diagnostics.ts:79, registry.ts:295/906, verification-run.ts:7, tools-server.ts:59, tool-results.ts and tool-utils.ts (preview retention), tool-group.tsx:106 and message-view.tsx:325.

## Verification on the final tree

- **247 tests passed across 27 files**, 0 failed. Scope includes task state/projection, actual SDK child replay, schema privacy/forensics, file/commit guards, preview persistence/UI wording, local runners, GSD, compaction retention, LSP diagnostic formatting and existing rate-limit controls. This is the targeted regression scope, not the full repository suite.
- `bun run build` exited **0**, including TypeScript compilation. The logs retain existing Vitest mock-hoist and Git fixture line-ending warnings; no warning-free test-run claim is made.
- Rebuilt native and external stdio tools-MCP controls passed **13/13**. Actual Node and pytest tests ran through the rebuilt MCP endpoint and exited 0. The Python experiment used a private .venv with system-site packages; no dependencies were downloaded by verification_run.
- Jest/Mocha selection and argument handling are covered with isolated local executable fixtures; no claim of complete integration with those actual packages or arbitrary consumer configurations.
- An AI SDK replay used a mocked model and actual native read/edit/Node-test tools: **4 model requests**, stages `orient → research → implement → verify`, without context_load calls. This proves the named SDK path, not paid-provider quality or production-session savings.
- Native tier1 offline TUI harness run **c9aeea2e-211c-43a5-bb18-8c9d17b96443** passed **2/2** (boot and passive transcript log). It is a bounded UI control, not end-to-end coverage of every new runner or preview interaction. Preview wording/provenance has separate unit/native controls.
- Whitespace check passed. No Git push, publication, server deploy, credential change or user MCP reconfiguration was performed.

## Measured fixture results

Same 1,000-line text file, actual compiled native read_file:

| Request | Returned characters |
|---|---:|
| Normal tool cap | 31,862 |
| max_chars=4096 | 3,947 |
| Lines 10–20 | 1,068 |

These are returned excerpt sizes, not whole-session token/cost/latency savings. Default read budget remains the normal cap; the agent must choose a useful range/budget. The compiled fixture's standalone tool registry had **43 native tools, 25,029 schema/name/description characters, 0 MCP characters**. This is one assembled toolset, not the entire live TUI inventory and not evidence that external MCP schemas caused the audited session's cost. Numeric attribution is now available to measure a future live toolset before considering lazy exposure.

## Failed controls retained and explained

1. The currently registered npx-based MCP selfverify run **f9ea153a-3177-4493-99f5-43e508ceac68** failed before boot: its cached published package could not resolve `@muonroi/agent-harness-core/selector`. It did not execute the rebuilt workspace package. The rebuilt local tools-MCP endpoint loaded successfully and passed the controls above. This task does not update that published/cached installation.
2. The first isolated local harness run passed boot but failed passive-log. Its final frame showed the provider picker with the composer text still present. The submit path in use-app-logic.tsx:8706 opens that picker when no credential is configured. Re-running with the standard fake offline-fixture key passed both scenarios. No real provider credential or production picker policy was changed. The failed fixture evidence is retained separately.
3. Initial RED tests demonstrated missing stage observation/schema details, preview and runner behavior. Corrections and final GREEN logs are retained; failed runs are not presented as test passes.

## Deliberate limits

No blanket LSP suppression, retry-budget increase, model switch, lazy schema filtering, automatic evidence replay or compaction disablement. The audited session supplied no confirmed 429, false-positive LSP reproduction or failed evidence retrieval proving those policy changes necessary. Existing rate-limit/LSP/retention controls passed in the targeted suite. A matched live-provider experiment is still needed to claim end-to-end cost, latency or quality improvement.

Restart a CLI process using this local build to load the changes. For external MCP, the tested entrypoint is `node D:/sources/Core/muonroi-cli/dist/src/index.js tools-mcp`. Restarting a cached npx package is a separate provenance and does not load this build.

## Evidence

Private scripts/logs: `.scratch/a044-context-followthrough/` (`accepted-tests.log`, `accepted-build.log`, `compiled-controls.mjs`, `compiled-controls.json`, `compiled-controls-missing-fixture-key.json`, wave RED/GREEN logs). Public SHA-256/summary manifest: `evidence/a044-context-followthrough-2026-10-16.json`. Source hashes include prior workspace edits in shared files; they do not attribute the entire dirty diff to this task.
