# Seven-day audit and watchdog repair preparation

## Verdict

The supplied report contains correct basic counters, but its token rankings, throw-hit claims, log attribution and several causal explanations are unsupported or contradicted by the stored data. The subsequent plan-request turn stalled in PIL preparation before the response-model/tool execution path.

This is an investigation and repair preparation artifact, not proof of a delivered fix.

## Evidence baseline

- Repository HEAD: `54e2a8c2ab9de3b8f93b7c5604b48e90b55ef264`.
- Existing staged/unstaged files were preserved. Production source and the existing analysis script were not changed.
- Database: `C:/Users/phila/.muonroi-cli/muonroi.db`, opened read-only, `query_only=ON`, queries collected in a single SQLite transaction.
- Reconstructed report window: `[2026-09-30T07:46:02.335Z, 2026-10-07T07:46:02.335Z)`. The upper bound deliberately excludes the newly reported watchdog row at the exact endpoint. The session timeline includes that row separately.
- Files: `snapshot.json`, `audit.cjs`, `inspect.cjs`, `pil-budget-probe.cjs`, `pil-budget-probe.json` in this directory.
- Runtime breadcrumb PID `6236` is still a Bun process, with entry path `dist/src/index.js`; the observed process is using built JavaScript, not the current TypeScript source directly.
- Built PIL files are dated October 5. SHA256: preprocessor `5216CB446AB8451861B78F0BD20C6CB3F2A5AC031416C31335146FF28C2253EE`; pipeline `7D9BA3DB4E8E26846BCDBE01BE7CFA387BDB0C54C55B7034ACD6BAE8391C9923`; classifier `314C5FA6913F84CBBD1997C4FCFF71E2B0C93DE02FFA4A5ACE4010D8973C0F1E`.
- These hashes identify the inspected/probed files; there is no captured historical build commit mapping for this process.

## Corrected counters

| Metric | Measured result | Interpretation |
|---|---:|---|
| Sessions created in window | 27 | Includes child sessions; not 27 distinct human conversations |
| Sessions with interaction rows in window | 26 | Different definition from created-session count |
| interaction_logs rows | 6,919 | Not approximately 5,000 for this defined window |
| tool_calls rows started in window | 840 | Separate table; do not equate with interaction event rows |
| usage_events rows | 655 | Includes sources with different accounting granularity |
| error events before new watchdog | 8 | 4 watchdog, 3 tool_markup_leak, 1 user-aborted council generation |
| error events including supplied failure | 9 | New row 53459 is the fifth watchdog error |
| stall_rescue | 6 | All outcome=rescued; stored fields do not identify a slow shell command |
| grounding_flag | 4 | Claims/count telemetry; not evidence of an automatic self-correction retry |
| Database main-file size observed | 61,587,456 bytes | Excludes the separately observed WAL/SHM files |

The original child session did obtain the 27/8/6/4 counters. Its tool-call row `6570` then failed before token statistics: `SqliteError: no such column: "$.throwHit" - should this be a string literal in single-quotes?` (bash run 19, exit code 1).

## Corrected prompt accounting

| Stage | Calls | Average est tokens | Peak est tokens | Total est tokens | Throw hits | Warn hits | System % | History % | Tool results % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| main | 587 | 59,168 | 119,069 | 34,731,459 | 0 | 0 | 30.1 | 15.7 | 54.2 |
| subagent | 677 | 39,176 | 85,433 | 26,522,074 | 0 | 0 | 17.3 | 28.5 | 54.2 |
| council | 174 | 14,689 | 56,813 | 2,555,887 | 0 | 0 | 5.0 | 29.6 | 65.4 |

No `call_accounting` rows with stage `pil` exist in this window. This does not prove PIL makes no LLM calls: the classifier uses `streamText` directly (`src/pil/llm-classify.ts:582`).

The percentages are weighted character shares across recorded prompts, not token shares and not the maximum percentage of an individual call. The original placeholders and percentages cannot establish a cost leak.

`call_accounting.input_tokens` is a prompt estimate from `Math.round(chars/4)` (`src/providers/model-gate.ts:82`, `:271`). It is not provider-reported usage or a billed monetary amount. The historical calibration comment about a roughly 2x difference is not a universal conversion factor.

The default throw threshold is **100,000**, configurable through `MUONROI_GATE_THROW_MAX_TOKENS` (`model-gate.ts:213`, `:239`). `throwHit` records threshold crossing; actual enforcement also depends on mode and stage (`:263-309`).

The highest subagent accounting row, **48924**, is 85,433 est, `ceilingMode=warn`, `throwCeiling=null`, `throwHit=false`. The highest main row, **53011**, is 119,069 est with `ceiling=256000`, `ceilingMode=warn`. Neither supports the claimed 80k hard-cap violation.

Stage and session kind are different axes. The report-producing child `5e827c722715` has `sessions.kind=subagent` but its transcript loop recorded 16 `main` accounting rows. Stage ranking alone cannot attribute all child-session costs to the `subagent` stage.

The `usage_events` snapshot provides input/output/cache counters and `cost_micros`; monetary values are catalog-based estimates (`src/storage/usage.ts:47`), and `task`/`council` rows can be aggregate operations. No provider invoice reconciliation or duplicate-accounting audit was performed; do not label their simple sum as the verified bill.

## Log corrections

- `crash.log:148` contains one EPIPE in the window, October 5. The stack is an **MCP server stdio transport**, including an npx-installed `@modelcontextprotocol/sdk/.../server/stdio.js:66`, not proof of a tee/gzip/less child pipe in CLI code. Changing protocol stdout to inherit requires transport-specific investigation.
- `crash.log:140` records `STDERR_TAIL_CHARS` on **September 24**, outside the window, in a `.claude/worktrees/...` source path. The inspected source defines it at `src/self-qa/orchestrator.ts:35`. This audit does not claim every historical worktree has been repaired.
- There are **zero** `[auto-commit] git add failed` lines in the defined seven-day window. The explicit ignored-path failure at `debug.log:493` is August 18 and names `.planning/STATE.md`. There is no seven-day permission/lock evidence supporting that diagnosis.
- The JSON warning is emitted by **compaction proposer**, `src/orchestrator/compaction.ts:144`; it is not proof of a council debate JSON failure. Four recent matching warning lines are `debug.log:2202,2299,2315,2325`; three have empty text, one contains ordinary prose and tool markup. Truncation was not established.
- Grounding currently appends a warning footnote and logs claims (`src/orchestrator/tool-engine.ts:4384-4410`); the four rows do not establish an automatic model correction loop.
- Stall rescue is the provider-stream recovery branch synthesizing existing tool results (`tool-engine.ts:3935-3985`). The six row payloads contain outcome/toolResultCount/chars, not the names or runtimes of a hanging build or lookup.

## Supplied watchdog: session cde402aafc74

Times below are local UTC+7 on October 7; original trace timestamps are UTC.

| Time | Evidence | Observation |
|---|---|---|
| 14:41:44.232 | debug.log:2338 | Analysis child outcome absorbed into parent |
| 14:41:54.251 | council-breadcrumbs.jsonl:505 | Follow-up route classification begins |
| 14:42:02.256 | breadcrumbs:506 | Route action DIRECT_ANSWER |
| 14:42:02.334 | breadcrumbs:515 | pre-stream.pilPrep.start in parent |
| 14:46:02.334 | debug.log:2339 | Idle watchdog fires |
| 14:46:02.335 | interaction_logs id 53459 | error/watchdog, kind=idle, lastPhase=pilPrep |

There is no matching `pilPrep.end`, no parent PIL completion/budget-log row, no response-model `call_accounting`, no new `usage_events`, and no tool execution recorded for this follow-up. The evidence places the stop **inside preparation**, before the main response/tool path. It does not identify the specific blocked classifier, discovery, EE, or other await inside that phase.

The phase remained open for 240 seconds. The error text describes the configured **idle window of 120 seconds**, not total elapsed turn duration. The watchdog can re-arm on progress signals (`turn-watchdog.ts:143-159`); the historical trace lacks the signal-level evidence needed to explain the first re-arm for this session.

`prepareTurnContext` is consumed through `await prepGen.next()` (`message-processor.ts:1215-1226`). It creates a discovery interaction handler and passes it to `runPipeline` (`preprocessor.ts:47-95`). The interactive path bypasses the outer pipeline timeout (`pipeline.ts:389-395`). The classifier uses an AbortController timer and directly drains `fullStream`; there is no independent deadline race around that drain (`llm-classify.ts:575-601`). These source facts define candidate investigation surfaces, not a proven historical leaf cause.

## Controlled runtime experiment

`pil-budget-probe.cjs` imports the inspected **built** pipeline and injects a classifier promise that never resolves. It makes no provider calls. Pipeline test budget is 25ms; external observation deadline is 150ms.

| Runtime | No interaction handler | Interaction handler present |
|---|---|---|
| Node 24.19.0 | pipeline-timeout fallback in 42ms | still pending at 156ms |
| Bun | pipeline-timeout fallback in 40ms | still pending at 150ms |

Both probes exited 0, asserting the observed difference. This reproduces the **timeout coverage gap** for automated work on the interactive path. It does not prove that a stalled classifier was the exact await in the historical session.

## Persistence gap

The parent database transcript has only seq 1 (original analysis request) and seq 2 (analysis answer). The follow-up plan request and watchdog response are absent from `messages`; only the error interaction row is durable.

User write-ahead persistence occurs at `message-processor.ts:1749-1766`, after PIL. The watchdog marks the latest pending row at `orchestrator.ts:4210`; no pending user row for this request exists to mark. This leaves the failed preparation request unavailable through transcript resume.

## Repair preparation and verification gates

| Priority / Wave | Allowed scope and outcome | Evidence / dependency | Verification required before delivery |
|---|---|---|---|
| P0 / W1 | Add turn-scoped start/end/error and deadline evidence around PIL layers/classification; reproduce the stuck preparation and bound automated awaits independently of provider abort compliance | id 53459, breadcrumb 515, runtime probe; exact historical leaf remains unknown | Fault-injected classifier ignoring abort must return/fail within deadline; cancellation must settle preparation; genuine user-answer wait must remain usable; next turn must proceed |
| P0 / W2 | Persist raw request before preparation and retain terminal failure once | Missing follow-up messages; depends on defining session/fork ownership in W1 | Pre-PIL failure leaves raw user row plus durable failure, no duplicate user rows on successful/forked turns, resume sees failed request |
| P1 / W1 | Make existing audit script runnable with ESM, parameterized SQL, read-only access and fixed window; report estimates, actual usage and historical log dates separately | tool rows 6570/6573/6574; verified script launch failure | Node command succeeds; all current fixture/window totals agree; JSON booleans counted correctly; DB remains read-only |
| P2 / W1 | Attribute prompt growth by accounting stage AND session tree/operation; inspect recurring payloads and existing dedup before changing limits | main peak 53011; subagent peak 48924; 0 throw hits | Trace selected growing calls; prove repeated payloads/re-serving and measure before/after; do not lower coverage or silently drop needed tool evidence |
| Deferred | MCP EPIPE transport lifecycle and compaction proposer output handling | Specific dated stacks/warning lines above | Reproduce closed transport or malformed proposer behavior in owner component before choosing changes |

This table is a research-gated repair preparation, not an execution-verified implementation plan. W1 must close the missing internal-await and cancellation evidence before implementation scope is locked. Do not increase/disable the watchdog as a diagnosed repair without that evidence.

For production/workflow changes: relevant build/typecheck, focused regression tests, full unit suite before any push, and the native `selfverify_*` TUI harness are required. No build, full suite, harness, implementation commit or push was performed for this read-only investigation.

Recommended next command:

`Use $qc-flow and resume from .quick-codex-flow/sessions/01a11553-1861-71b1-ae14-b6f2bd03444e/runs/seven-day-watchdog-audit.md. Open P0/W1 for session cde402aafc74: close the PIL internal-await and cancellation evidence gaps, then verify the repair plan before editing production source.`
