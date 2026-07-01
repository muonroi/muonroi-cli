# Plan: Preserve Approved Plan Context on "tiếp tục" / "continue" after Interrupt (Plan Creation Flow)

## Problem Statement (from user + session forensics)
When the agent is creating a work plan (via council, generate_plan, respond_plan, or todo_write + plan scaffolding), if the user interrupts (ESC / halt) or the turn ends, and then types a bare continuation phrase ("tiếp tục", "continue", "ok", "next", etc.), the agent forgets the prior plan context:
- It re-asks for scope/details instead of resuming the approved plan.
- The `APPROVED PLAN:` section (injected via planContext into system prompt) is missing on the continuation turn.
- Evidence from sessions (e.g. around 5793f1723b42, c47d1986e083, ff932f8568e8): plan was emitted, user said "tiếp tục", agent treated as fresh general/chitchat.

This violates the documented "Agent Interruption & Prioritization Rule" (AGENTS.md:91-93): "When the agent is performing a task and the user interrupts ..., the agent must prioritize the unfinished work".

## Root Cause Analysis (evidence from this turn's reads/greps)
1. **Transient-only planContext**:
   - `src/orchestrator/orchestrator.ts:293`: `private planContext: string | null = null;`
   - `src/orchestrator/orchestrator.ts:568`: `setPlanContext(ctx)` just assigns in-memory.
   - Injected only via `buildSystemPromptParts` (prompts.ts:617): `const planSection = planContext ? `\n\nAPPROVED PLAN:\n...${planContext}\n` : "";`
   - No DB column or write path for the approved plan text. (Contrast with todo snapshots via `getLastTodoWriteArgs`.)

2. **Unconditional clear every turn**:
   - `src/orchestrator/message-processor.ts:1114`: `deps.setPlanContext(null);`
   - This runs at the start of *every* processMessage turn, *before* system prompt assembly (1022, 1036).
   - Even if the same Agent instance still had a planContext (after user ESC abort), it is wiped.
   - For new process ( `--session` resume or picker), it is always null.

3. **Continuation short-circuit does not restore plan**:
   - `src/pil/layer1-intent.ts:216`: `CONTINUATION_FULL_RE` (bilingual, short phrases only) + `isContinuationPhrase` (317).
   - Pass 0 (875): if match → pins "general"/chitchat, skips classifier. Correct for avoiding wrong scaffold, but planContext is not re-hydrated.
   - `src/orchestrator/scope-ceiling.ts:162`: `recordSessionLastTask` + `getSessionLastTask` (Phase 5) protects *ceiling* for continuations, but nothing analogous for planContext.
   - `src/orchestrator/tool-engine.ts:874`: `_priorTurnHadTools` guard keeps tools for continuation, but plan text is separate.

4. **No persistence / re-hydration path**:
   - `getLastTodoWriteArgs` (storage/transcript.ts:815) scans `tool_calls` for 'todo_write' across session chain — works for todo panel.
   - Plans are emitted via:
     - `generate_plan` tool (interactive UI, council path).
     - `respond_plan` (structured response tool, PlanSchema in pil/response-tools.ts:25).
     - Council "generate_plan" action (council/index.ts:746) → synthesisText.
   - These write to `tool_calls` (args_json) and/or messages, but nothing reads them back into planContext on resume/continue.
   - `discardAbortedTurn` (orchestrator.ts:924) only stubs "[Interrupted]"; does not snapshot plan.
   - `buildInterruptedTurnNote` (interrupted-turn.ts) only for stalls.

5. **Compaction / transcript load does not carry plan**:
   - B3/B4 compaction (compaction.ts) summarizes; high-level "Active Plan" may survive in summary, but the verbatim APPROVED PLAN block for prompt injection does not.
   - loadTranscriptState / buildEffectiveTranscript do not reconstruct planContext.

6. **Related but separate mechanisms that already work partially**:
   - PIL prompts.ts "PRIORITIZE RECENT CONTEXT" rule.
   - scope-ceiling inheritance for continuation.
   - write-ahead persistence (A4/A5) ensures tool_calls and messages are durable.
   - AGENTS.md policy exists but is advisory only (no code enforcement for plan state).

Sessions analyzed (via direct DB + code): plan creation happened, "tiếp tục" turns succeeded for *implementation* chunks in some cases (because recent context + last-task), but failed or risked failure for the *plan presentation/approval* window itself.

## Goals
- When user says a bare continuation phrase after an interrupt/halt during plan creation or approved-plan execution:
  - The next system prompt MUST contain the prior `APPROVED PLAN:` block.
  - Agent resumes the plan (executes next step, asks for confirmation on the same plan, etc.) instead of re-clarifying scope.
- Must work for:
  - Same-process continuation (ESC then "tiếp tục").
  - Cross-process resume (new CLI, pick prior session via --session or /sessions).
- Smallest correct change; reuse existing patterns (todo snapshot, continuation regex, tool_calls scan).
- No new DB schema (reuse tool_calls + messages; v9 FTS is already there).
- Preserve existing behavior for non-continuation turns (clear plan when starting fresh task).

## Non-Goals (out of scope for this minimal fix)
- Full structured plan versioning / multi-plan history.
- Auto-detect "plan in free text" without tool_call (future if needed).
- Changes to council/sprint-runner flow (they already produce the plan).
- UI changes to surface "resumed plan".
- Migration (no schema change).

## Solution Design (smallest delta)
1. **Storage helper** (modeled exactly on getLastTodoWriteArgs):
   - `src/storage/transcript.ts`: new `getLastApprovedPlan(sessionId: string): string | null`
     - Walk session chain (parent support).
     - Prefer latest tool_call where tool_name IN ('generate_plan', 'respond_plan').
     - Parse args_json; if it looks like PlanSchema (has steps) or generate_plan payload, return pretty JSON or raw string suitable for prompt injection.
     - Fallback (v1 minimal): if no tool_call hit, scan last few assistant messages in the transcript for content containing "plan" or "APPROVED PLAN" marker and return a truncated relevant slice. (Keeps it robust without new tables.)
   - Export from `src/storage/index.ts`.

2. **Guard + re-hydrate in turn start** (message-processor.ts):
   - Import `isContinuationPhrase` from "../pil/layer1-intent.js" (already exported) and the new `getLastApprovedPlan`.
   - Replace the unconditional:
     ```ts
     deps.setPlanContext(null);
     ```
     with:
     ```ts
     const _isCont = isContinuationPhrase(userMessage);
     if (!_isCont) {
       deps.setPlanContext(null);
     } else if (!deps.getPlanContext()) {
       const _p = getLastApprovedPlan(deps.session?.id ?? "");
       if (_p) deps.setPlanContext(_p);
     }
     ```
   - This runs early enough (before systemParts build at ~1018-1028 and toolTurnParts).
   - For same-process: if planContext was still alive in the Agent, the `!deps.getPlanContext()` keeps it; the load is the cross-process safety net.
   - Also pass the (possibly restored) planContext into both static and tool-turn system prompt builders.

3. **Optional hardening (small)**:
   - In `discardAbortedTurn` (orchestrator.ts), if a planContext exists, consider appending a one-line note to the stub assistant message so transcript search can find it. (Low priority; tool_calls scan should suffice.)
   - Ensure `getLastApprovedPlan` also considers the last compaction summary if it mentions an "Active Plan" (cheap; parse the summary text for a marker). Not required for v1.

4. **No changes needed**:
   - prompts.ts already correctly injects whatever non-null planContext is passed.
   - layer1-intent.ts continuation logic stays as-is (it correctly routes to general so we don't re-scaffold; we just restore the plan var).
   - scope-ceiling.ts last-task already protects budget.
   - tool-engine.ts _priorTurnHadTools already keeps tools.

## Implementation Order (wave)
Wave 1 (core, unblocks the bug):
- Add + export getLastApprovedPlan.
- Conditional set + hydrate in message-processor.
- Typecheck + minimal unit touch if any (storage transcript tests already cover getLastTodoWriteArgs pattern).

Wave 2 (verify):
- Manual dogfood via real TUI or MCP harness (per AGENTS.md + CLAUDE.md: drive with "lên kế hoạch ...", ESC, "tiếp tục", observe APPROVED PLAN in prompt and behavior).
- Run `bun run typecheck`.
- Run relevant tests: `bunx vitest run src/storage/__tests__ src/orchestrator/__tests__/message-processor.test.ts` (or full if fast).
- If plan tool_calls are not the source in some flows (e.g. pure council synthesis), extend the fallback inside getLastApprovedPlan to also look at recent messages containing plan JSON/text.

Wave 3 (docs / polish if time):
- Add a one-line note in AGENTS.md under the Interruption rule citing the automatic plan re-hydration.
- Consider emitting a tiny "plan resumed" toast / log on successful hydrate (optional, non-blocking).

## Verification Criteria (UAT)
- Start a plan creation flow (e.g. "/ideal build X" or explicit plan request) until "APPROVED PLAN" appears or generate_plan/respond_plan is called.
- Interrupt (ESC or stop).
- Type "tiếp tục" (or "continue").
- Agent must:
  - NOT re-ask "What do you want to build?" or scope questions.
  - Reference or continue executing steps from the prior approved plan.
  - System prompt for that turn (observable via debug or --log) contains the "APPROVED PLAN:" section.
- Same for cross-launch: close CLI, reopen with session picker or `--session <id>`, type "tiếp tục".
- Non-continuation new task ("build a different thing") must still clear the old plan (no leakage).
- Existing todo snapshot and continuation ceiling behavior unaffected.
- 0 new red tests; typecheck clean.

## Risks & Mitigations
- Risk: getLastApprovedPlan returns stale plan from a much earlier turn. Mitigation: limit to recent (last 50 messages or last compaction boundary) + only use on explicit short continuation phrase (already length <=40 in isContinuationPhrase).
- Risk: plan text too large for prompt. Mitigation: existing planContext usage already assumes it fits; if needed we can truncate inside the helper (same as todo).
- Risk: council synthesis path does not write a 'respond_plan' tool_call. Mitigation: implement message fallback scan in the helper.
- No schema change → zero migration risk.

## Files to Touch (minimal)
- src/storage/transcript.ts (add function, ~25-40 LOC)
- src/storage/index.ts (one export line)
- src/orchestrator/message-processor.ts (import + ~8 LOC conditional around 1114)
- (optional) PLAN-plan-context-resume-fix.md (this doc)
- (post) AGENTS.md if rule needs codifying

## Commit Strategy
- One focused commit after typecheck + basic test run: "fix(plan-resume): re-hydrate planContext on continuation phrases after interrupt (tiếp tục / continue)"
- Include "Coding by - Muonroi-CLI" trailer.
- Pre-push: typecheck + vitest for storage + message-processor slices. Use self-verify if TUI surfaces touched (not in this change).

## References (from this investigation turn)
- AGENTS.md:91 (Interruption rule)
- src/pil/layer1-intent.ts:216 (CONTINUATION_FULL_RE), 317 (isContinuationPhrase), 875 (Pass 0)
- src/orchestrator/message-processor.ts:1114 (the clear), 1018 (system build)
- src/orchestrator/orchestrator.ts:293,568 (planContext field + setter)
- src/orchestrator/prompts.ts:617 (APPROVED PLAN injection)
- src/storage/transcript.ts:815 (getLastTodoWriteArgs pattern to copy)
- src/storage/migrations.ts:152 (messages), 162 (tool_calls) — no new tables
- src/council/index.ts:746, src/pil/response-tools.ts:82 (plan sources)
- scope-ceiling.ts:162 (prior art for continuation inheritance)

This plan is evidence-based on code read this session + DB session forensics. Implement in smallest deltas, verify with real usage per maturity rules.
