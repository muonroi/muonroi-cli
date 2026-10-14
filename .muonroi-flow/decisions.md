## Decisions

- evaluation unavailable   │  │ Mode: Agent              │
- Write improvement plan to file docs/improvement-plan.md
- Classify plan items into 3 groups: remove (Group 1), re-anchor (Group 2), keep (Group 3)
- Implement items #3, #6, #8, #9, #10 in current session
- Leave items #7, #4, #5, #1, #2 for next session due to tool budget exhaustion
- Remove items #1, #5, #7 from plan entirely (false data / non-existent symbols)
- Re-anchor item #2 to prompts.ts:642 (was 245-407)
- Mark quantitative claims in items #3, #4, #6, #8, #9, #10 as DEFER/UNVERIFIED pending re-measurement

## Facts

- muonroi-cli has 6-layer PIL (Prompt Intelligence Layer) at src/pil/pipeline.ts
- muonroi-cli has GSD workflow: gsd_discuss → gsd_plan → gsd_plan_review → gsd_execute → gsd_verify → gsd_ship
- muonroi-cli has Experience Engine (EE) with persistent cross-session memory via ee_query/ee_write/ee_feedback
- System prompt assembly: buildSystemPrompt() at src/orchestrator/prompts.ts:642 (NOT 245-407)
- buildSystemPromptParts() at src/orchestrator/prompts.ts:584
- Metered gate function: wrapModelWithGate() at src/providers/model-gate.ts:348, call site at src/providers/runtime.ts:297
- wrapToolSetWithCap() at src/orchestrator/sub-agent-cap.ts:321 (sub-agent cap, NOT model gate)
- wrapToolSetWithDedup does NOT exist in codebase (grep returns 0 matches)
- Session 526a83cf22df returned 0 rows in live DB views (contradicts original 2.44M token claim)
- 0 ceiling hits recorded across 4,593 calls (contradicts original ceiling hit claim)
- session_views table does NOT exist; correct table is session_history_fts at src/storage/migrations.ts:103-118
- call_accounting exists as event_subtype in interaction_logs
- mutation-gate.ts:34-42 only blocks heavy tier; quick/standard fail-open
- PaymentSettings marked @deprecated Phase 4 since 2026-07 at src/utils/settings.ts:60-79
- arg-guard.ts:214 returns TODO for unrecognized arg types
- grep.ts hardcodes MAX_MATCHES=100 and MAX_LINE_LENGTH=2000 (lines 7-8)
- truncateOutput() at src/tools/registry.ts:173-175 has no truncation logging
- FIXME(WhoAmI-L5) at src/pil/layer5-context.ts:9 — work_patterns.multitasking deferred
- 5 session IDs for shell-mismatch (f9a4cea1bf44, 9c63a38197f3, d0dc4a1f542a, 77cd2e11c6a5, 1bc27b79223c) — no DB evidence found in current turn
- makeStanceRecall implemented at src/council/stance-recall.ts, called from src/council/debate.ts:897-906
- council-bridge.ts:24-45 confirms only 2 EE collections (experience-behavioral, experience-principles), no workflow_* collections
- phase-outcome.ts:77-117 implements POST /api/phase-outcome (fire-and-forget)
- workflow-event.ts:49-110 implements POST /api/workflow-event client-side (404-drop, offline-queue)
- fold-planning.ts:1-109 implements .planning → .muonroi-flow migration (copy-only, idempotent, marker-guarded)
- @opengsd/gsd-core removed from package.json (0 matches on grep)
- LATEST_DB_VERSION=10 in src/storage/migrations.ts
- cross-turn dedup (C3) wraps tool set at src/orchestrator/tool-engine.ts:47
- Pattern guard at src/orchestrator/tool-loop-cap.ts:9-17 fires when ≥3 of last 5 calls have same canonical args hash
- TOKEN BUDGET rule: ~17K tokens/system round (claimed, but anchor at 245-407 is dead — needs re-verify at 642)
- Implementation status this session: #3 passed (7/7 tests), #6/#8/#9/#10 typecheck clean

## Constraints

- Plan file must remain at docs/improvement-plan.md (cannot rename or relocate)
- All code identifiers, function names, file paths must remain in English exactly as they appear in source
- Every claim in plan must cite verifiable source: file:line from current source tree OR numeric result from SQL query via bun:sqlite
- Do not infer or estimate replacement numbers without evidence — remove figures entirely if no evidence exists
- Do not implement improvements or add features outside scope of plan file
- Do not reopen settled decisions from prior turns — build on them
- Tool output budget exhausted: 216K after 171 calls across 92 steps
- 3/10 original plan items removed (Group 1): #1 (false session data), #5 (no DB evidence), #7 (non-existent symbol)
- 1/10 items re-anchored (Group 2): #2 (wrong file:line range)
- 6/10 items kept with DEFER markers (Group 3): #3, #4, #6, #8, #9, #10
- Items requiring re-measurement before actionable: #2 (17K tokens/turn), #3 (workflow_*/docs-in-debate), #4 (server endpoint), #9 (intra-session gating)
