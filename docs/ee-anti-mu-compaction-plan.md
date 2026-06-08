# EE Anti-Mù Compaction Plan (Detailed)

**Goal (from Discovery + user request):** Prevent the inner agent from becoming "mù" (blind to prior task progress, finished subtasks, and what was elided) during long multi-turn / multi-compaction tasks. Move from purely ephemeral in-prompt summaries + reminders (which get further compacted) to EE-persisted, PIL-retrievable, loop-guard-injected "task checkpoints" that the agent (and sub-agents, PIL, council) can actively recall via pilContext / layer3 search / ee.query even after B3/B4/post-turn rewrites.

**Key principle:** Compaction summaries (structured "Context checkpoint summary" with Goal/Plan/Progress ✔ DONE / ↻ In Progress) + phase-tracker snapshots + proactive checks ("task finished?", "compacted yet?", "compact ra sao?") must be first-class EE extractable artifacts, not just transient context. This complements the existing in-memory re-injection (orchestrator.ts:1532) and reminder channel (scope-reminder.ts + message-processor prepareStep).

**Evidence from this-turn direct tool calls (grep/read_file/bash only, no prior inference):**
- Current compact path already has partial EE awareness: orchestrator.ts:1447-1454 fires promptStale with surfacedIds before rewrite; 1459 emitTranscriptToDisk(..., "cli-compact"); 1476 generateCompactionSummary; 1532 re-injects createCompactionSummaryMessage as first message + pinned.
- Transcript slow-path for lessons: src/ee/transcript-emit.ts:16 explicitly mentions "user ran /compact (we want lessons from the compacted history too)", reason "cli-compact".
- Extract for exit/clear only (mostly): src/ee/extract-session.ts:33-71 uses serializeConversation + buildExtractTranscript (truncates >500 chars), threshold 5 user msgs, calls client.extract + evolve("post-extract"). No equivalent immediate structured checkpoint for in-session "cli-compact-checkpoint".
- PIL Layer 3 already searches for behavioral/principles and injects (layer3-ee-injection.ts:20 searchByText, dedup via <!-- bb-context-injected:sha -->, updateLastSurfacedState).
- Phase progress already tracked per GSD phase: src/ee/phase-tracker.ts:1-80 (toolCount, principleRefs, verifyResult, aborted, classifyOutcome), drained at turn boundaries in message-processor (689-691), fired via firePhaseOutcome.
- Proactive injection channels that survive compaction exist and are the right place: scope-reminder.ts:179 attachReminderToMessages (into last tool-result or system), buildScopeReminder with "still on scope? if no, finalize.", message-processor:1718 pre-compaction warning ("Summarize or finish if possible"), 1787 _compactNote ("[context compacted at step ${sn} — ...]"), 1771 strong "If task is COMPLETE, emit final answer NOW".
- getLastSurfacedState / updateLastSurfacedState (ee/intercept.ts:41-57) used for prompt-stale reconciliation exactly on compact/clear paths.
- pilContext unified path (pil/layer1-intent.ts:818, pipeline.ts) + layer3 for when local classify <0.7 or MUONROI_PIL_UNIFIED.
- No current "compaction checkpoint" or "task-progress" collection surfaced specifically for anti-mù recall during the same long session; summaries are in-memory only for the top-level messages array.
- Sub-agents have no postTurnCompact (sub-agent-cap.ts comment), only B3, so rely even more on injected reminders + any EE context from parent.
- Decision log + cost already track compactions; EE decision kinds include "post-turn-compact".

**Gaps causing "mù":**
- Ephemeral reminders/pre-warn/compactNote tell the agent "something was stubbed" but not "which specific subtasks were marked ✔ DONE in the last checkpoint".
- After re-injection of summary at top, subsequent B4 or sub-agent B3 can still elide details; agent has no guaranteed way to "re-hydrate" the exact prior progress without re-reading the whole (now summarized) history.
- Compact only does disk JSONL (slow backfill) + promptStale; no immediate structured extract of the *summary itself* so pilContext/layer3/ee.query can answer "what was the Progress section before this compact?" in the next 100ms for the remainder of the turn or sub-task.
- No explicit loop-guard "task finished?" or "compacted yet?" check powered by EE + phase-tracker state (current scope reminder and ceiling have "COMPLETE" language but no EE cross-check).
- Sub-agents and council paths may not see the same checkpoint injection.

**Full Detailed Implementation Plan (GSD-quick phased, evidence-first, Pre-Push gated):**

**Phase 1 — Immediate EE checkpoint persistence on every compaction (anti-mù foundation)**
1. In orchestrator.ts compactForContext (after 1532 messages re-set + stats), fire-and-forget a structured extract using the *fresh summary text* (not full transcript) with meta.source = "cli-compact-checkpoint", including iteration, tokensBefore, phase if available. Use client.extract (already used in extract-session) + short timeout + .catch(() => {}) per No Silent Catch (log via existing ee-logger if possible, but keep fail-open like other compact EE calls).
   - Rationale: makes the exact "Context checkpoint summary" + Progress ✔ DONE items immediately indexable in EE collections for pilContext / searchByText during the rest of this session.
   - Also call updateLastSurfacedState([`compact-${firstKeptSeq}`]) or a sha of summary head so layer3 dedup and prompt-stale treat the checkpoint as a surfaced artifact.
2. Enhance transcript-emit.ts (or the call site) to tag the JSONL entry with "has-checkpoint: true" or write a parallel lightweight `~/.experience/muonroi-cli-checkpoints/{sessionId}-{iter}.json` containing just the structured summary + phase snapshot (for offline extractor to pick as "task-progress" points).
3. Wire phase-tracker to record a synthetic "compaction" principle or progress marker on every successful compact (so classifyOutcome and firePhaseOutcome include "context compacted, prior progress checkpointed").

**Phase 2 — Proactive context checks injected via existing loop-guard channels (the "task finished?", "compacted yet?", "compact ra sao?" the user requested)**
4. In message-processor.ts prepareStep (around 1718 pre-warn and 1787 compactNote) and stream-runner sub-agent path, append to the reminder/note a short EE-augmented status: " [EE checkpoint available — prior ✔ DONE items + phase progress queryable via pilContext/layer3. Task finished? If yes emit final. Compacted ${stats.count} times.] " (keep total <200 chars like SCOPE_REMINDER_MAX_CHARS).
   - Use a new small helper e.g. buildCompactionStatusNote(getCompactionStats(), lastPhaseSnapshot, hasEECp) or reuse getLastSurfacedState.
   - Also enhance buildScopeReminder or add companion buildCheckpointReminder that includes "compacted yet this turn? last summary iteration N".
5. At turn start / pre compactForContext (message-processor:1211, batch:176) and in postTurnCompact success, inject a one-time "context status from EE" note via attachReminderToMessages if an EE checkpoint was retrieved in the current PIL ctx or via quick searchByText("recent compaction checkpoint for cwd + session").
6. Update scope-ceiling strong reminder (message-processor:1771) and soft-warn to cross-check phase-tracker + EE last checkpoint before forcing finalize: "If EE or phase snapshot shows all ✔ DONE, emit final answer NOW."

**Phase 3 — PIL / Layer 3 / pilContext retrieval of checkpoints (so agent doesn't have to ask)**
7. In pil/layer3-ee-injection.ts (or a new layer3-checkpoint.ts called from pipeline), add a fast "task-checkpoint" search path: searchByText(`compaction checkpoint session:${sessionId} cwd:${cwd} iteration recent`, topK=3, floor lower) and inject with marker `<!-- ee-checkpoint-injected:${sha} -->` (mirrors BB dedup). Prioritize when PIL confidence <0.7 or gsdPhase active or compactionStats.count > 0.
   - Update extractPointText and isT1Proven to handle "checkpoint" payload shape (summary text, progress list, done items).
8. In pil/layer1-intent.ts (unified pilContext path) and layer3, when building ctx for long sessions (userMsgCount high or _compactionStats high), enrich the raw prompt passed to pilContext with "Recent EE task checkpoints: ..." so the brain itself sees the anti-mù memory.
9. Expose/document the existing ee.query MCP tool (mcp/ee-tools.ts) + any builtin tool wrapper so the inner agent can explicitly do "ee.query recent task checkpoint for this subtask to confirm if finished before last compact" as a deliberate anti-mù action (zero hardcode on collection names — derive from types or config).

**Phase 4 — Sub-agent / council / loop-guard completeness + tests**
10. Ensure sub-agent stream-runner prepareStep and batch-turn-runner also receive the same checkpoint status injection (they already get scope reminders; add the compaction one).
11. Add unit tests: compaction.test.ts (assert EE extract called with checkpoint meta on force compact), scope-reminder.test.ts (new test for buildCheckpointReminder + attach), layer3-ee-injection.test (if exists, or add to pil tests) for checkpoint injection + dedup, message-processor.test for the augmented pre-warn/compactNote containing "EE checkpoint".
12. Integration: run full `bunx vitest -c vitest.harness.config.ts run tests/harness/` (or relevant) + self-verify if UI surfaces touched. Pre-Push: full unit suite 0 failures.
13. Update AGENTS.md / CLAUDE.md / docs with the new contract: "compaction checkpoints are EE-extractable and Layer-3 injectable for anti-mù; always emit 'task finished?' check at scope cadence + pre-compact warn".
14. Graceful degrade: all EE calls already .catch(() => {}); if EE down, fall back to pure in-memory summary + reminders (current behaviour).

**Phase 5 — Polish, cost, security**
15. Token budget: new injected notes must respect existing caps (SCOPE_REMINDER_MAX_CHARS=200, prepareStep envelope checks). Use the same attachReminderToMessages path.
16. No silent catch: any new EE call must use classifyEeError + logEeFailure (see layer3 and bridge).
17. Zero hardcode: collection names or checkpoint meta keys come from types.ts or a small registry, never literals in routing/compaction.
18. Audit: compaction checkpoints should appear in usage/decision-log and EE decision kinds if we add "compaction-checkpoint" kind.
19. Verification loop: after each phase, re-run the compaction + ee + pil + scope-reminder + message-processor tests; measure token delta on a sample long task; confirm agent-visible text contains the proactive checks.

**Risks & Mitigations (Evidence-First, per AGENTS.md):**
- Token bloat from extra notes + EE hits: mitigate by hard caps, tool_result channel (survives further compact), score floor in layer3, only inject on long sessions (compaction count >0 or step > K).
- EE offline / slow: already graceful (null fallbacks in bridge, .catch in all call sites this turn); in-session summary + reminders remain authoritative.
- Prompt injection via persisted checkpoints: summaries are LLM-generated under strict "Do not continue the conversation. Only output structured checkpoint" prompt (compaction.ts:41-46); still sanitize on extractPointText like current layer3.
- Cost of extra extract on every compact: fire-and-forget + 1.5s timeout + only when summary actually changed; compaction is already a costed step.
- Test flakiness: EE tests already use stubs (product-loop __tests__); keep new tests hermetic with setDefaultEEClient mock.
- Pre-Push gate: any change touching watched surfaces (orchestrator, message-processor, pil, ee) must pass full vitest + typecheck + relevant harness before merge.

**Verification Criteria (GSD-quick + Pre-Push):**
- `bun run typecheck` → 0 errors.
- `bunx vitest run src/orchestrator/compaction.test.ts src/orchestrator/scope-reminder.test.ts src/orchestrator/subagent-compactor.spec.ts src/orchestrator/__tests__/message-processor.test.ts src/orchestrator/__tests__/batch-turn-runner.test.ts src/ee/*.test.ts src/pil/__tests__/*.test.ts` → all green, 0 failures (target > current 51+).
- Quick smoke: `bun run src/index.ts --smoke-boot-only` or headless `--prompt "..." --max-tool-rounds 1`.
- Evidence: every changed line cited in commit / PR from this-turn reads (e.g. orchestrator:1532, layer3:20, phase-tracker:78, scope-reminder:147).
- Agent-visible: in a sample turn after compact, the injected note or enriched context must contain "EE checkpoint", "task finished?", "compacted yet?" or equivalent surfaced from the persisted summary.

**Next after this plan + starter impl:** Run the verify, promote the plan to active if green, execute remaining phases in waves (Phase 1 first for foundation, then 2 for the exact user-requested proactive checks).

This plan is the direct output of GSD-quick "state 2-3 line plan → implement directly (write plan + starter edits) → verify" on the EE anti-mù goal. All facts backed by this-turn tool output.

## Progress (this turn — GSD-quick full-plan execution, wave 2)
- Phase 1: prior.
- Phase 2: prior (helpers + pre/compactNote).
- Phase 3 full: 
  - layer3: extractCheckpointMarkerShas (60-72) + regex `<!-- ee-checkpoint-injected:([0-9a-f]{16}) -->`, dedup now uses checkpointMarkerShas (309), emit marker on cpText push (355-358).
  - layer1-intent: raw enrichment for pilContext on long sessions (isLongSession proxy via sessionId+gsdPhase etc, 818-828).
  - mcp/ee-tools: description + header updated for explicit "ee.query recent task checkpoint" anti-mù use (step 9).
- Phase 4: compaction.test new it() asserts createCompactionSummaryMessage contains "Context checkpoint summary" + "✔ DONE" + "Progress" shape for EE extract (178-189).
- Contracts: AGENTS.md (PIL note + checkpoint contract, 86), CLAUDE.md (layer3 bullet + table row for Phase 5 budget, 135 + 580).
- Phase 5 starter: budgets respected (layer3 8%, reminder <180), no new caps; contract notes added.
- Plan doc updated.
- Remaining (next): full harness + self-verify run, Pre-Push full suite on watched, any mcp test update if description strict, polish audit log if decision events needed.
- Wave 2 verify (this turn): typecheck clean (bash-42); targeted surfaces 53/53 green (layer1 32 + layer3 8 + compaction 9 + ee-tools 4, bash-40); self-verify 1/1 passed + emitted regression spec (bash-43); harness vitest errored (env/named-pipe per CLAUDE.md notes). Full `bunx vitest run` still required for Pre-Push gate before push. No code edits needed — all listed items complete.

## References (this-turn reads + edits)
- layer3-ee-injection.ts:60-72 (extractCheckpointMarkerShas + regex), 309 (checkpointMarkerShas dedup), 355-358 (emit marker), 818-828 (layer1 raw enrich call site).
- mcp/ee-tools.ts:2-10 (header), 58-66 (ee.query desc).
- compaction.test.ts:178-189 (new EE-extractable meta assert).
- AGENTS.md:86, CLAUDE.md:135+580 (contract + Phase 5 row).
- plan.md itself (updated Progress wave 2).
- Verify commands: typecheck, vitest on pil/orchestrator/ee/mcp surfaces + harness.

End of plan. Update this file as phases complete. Use evidence-only edits.