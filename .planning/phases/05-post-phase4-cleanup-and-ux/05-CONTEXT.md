# Phase 5 — Post-Phase-4 Cleanup + UX Bugs

**Opened:** 2026-05-25
**Trigger:** Phase 4 closure 5-baseline re-run surfaced 2 new UX bugs (F6, F7)
in addition to 2 known deferred items (F4, F5).

**Kim chỉ nam (unchanged from Phase 4):** Drive cheap LLMs to senior-quality
output via structural CLI steering. Zero wasted tokens on scope wandering.
Quality per emitted token ≥ current.

---

## Scope — 4 components

### F4 — PIL discovery module-suggestion is incorrect

**Symptom:** During PIL Layer 1.6 clarity interview, the askcard "Which part
of the codebase should this target?" suggests modules that do NOT exist in
the current repo. Confirmed on `muonroi-cli`:

  - "agent-harness" — exists only as `src/agent-harness/` shim re-exporting
    from `packages/agent-harness-*`. The discovery treats this as a top-level
    module label.
  - "billing" — does NOT exist in muonroi-cli at all.
  - "chat" — does NOT exist in muonroi-cli at all.

**Suspected source:** `src/pil/layer15-context-scan.ts` — populates
`projectContext.relevantModules`. Likely scans EE seed patterns (`eePatterns`)
which include cross-project module names instead of (or in addition to)
filesystem-derived top-level folders.

**Acceptance:** module-suggestion options must come from `fs.readdir(cwd)`
filtered by language/framework heuristics, ranked by recency. EE patterns may
ADD candidates but never REPLACE filesystem-grounded ones.

### F5 — EE 100% IRRELEVANT logging noise

**Symptom:** Every `ee_judge` event in interaction_logs is classified
`IRRELEVANT` with `hadWarnings=false, agent_response_to_ee="no_warning_present"`.
This is logging noise — when EE has no warnings to issue, it should not write
a judge event at all.

**Quantified impact:** Session `5b7935e07f37` (prompt 2): 24 `ee_judge` rows,
all IRRELEVANT. Session `91b134d50c77` (prompt 4): 36 `ee_judge` rows, same.
Across the 5-baseline = ~100+ no-op rows.

**Suspected source:** `src/ee/judge.ts` (or equivalent) — currently writes
event regardless of warning presence. Should short-circuit when
`hadWarnings=false`.

**Acceptance:** When EE intercept produces no warnings, no `ee_judge` row is
written. Coverage spec: `tests/ee/judge-noise.test.ts` asserts judge event
absent for tool calls with zero warnings.

### F6 — Agent halts after tool sequence without emitting answer ("tiếp tục" bug)

**Symptom:** Across ALL 5 Phase-4-verification sessions, the agent completes
its tool-call sequence but emits only a partial intro ("Now I have enough
context. Here's the summary:") then stops. User must type `"tiếp tục"` to
get the actual answer, which the agent then delivers immediately (no new
tool calls — uses existing context).

**Evidence (session 348b4006e74c):**

  - Messages 1-11: user prompt → 7 tool calls (grep, read_file × 5, grep)
  - Message 11 ends with tool_result, `_sizeCapped: true`
  - Message 12 = user "tiếp tục" (NO assistant message between 11 and 12)
  - Message 13 = full 3636-char summary, no new tool calls
  - `agent_response` event for turn 1 recorded `textLength=515` — partial
    intro that never reached a persisted assistant message row

**Suspected root causes (need investigation in plan-phase):**

  1. AI SDK stream ends with finishReason="length" or "stop" mid-summary
     because something interrupts the text-only step after the last tool
     result. Could be the **size-cap on last tool_result** propagating an
     unexpected state to the model.
  2. `incSessionStep()` in scope-ceiling.ts may inflate counter beyond the
     actual step count (called every stopWhen invocation, not every step).
     Need to verify 7 tool calls didn't push counter to 10 via repeated
     stopWhen evaluations.
  3. `_sizeCapped` flag on tool_result may signal "context cut" to the model,
     prompting it to emit "I have enough context" without finishing.
  4. SiliconFlow DeepSeek V4 Flash quirk where text emission after a long
     tool-call chain gets prematurely terminated.

**Acceptance:** A baseline `analyze` prompt with 5-10 tool calls must produce
a complete summary in turn 1 WITHOUT the user needing to type "tiếp tục".
Quantified: `agent_response.textLength` ≥ 1500 chars for analyze/explain
prompts in the 5-baseline set.

**Note:** This is the highest-priority Phase 5 item. It directly contradicts
the kim chỉ nam — the agent is "wasting" the user's time by halting.

### F7 — TUI default-collapse on long final responses ("ctrl+e expand")

**Symptom:** Long agent responses get collapsed in the TUI with a footer
`ctrl+e expand (63 more lines)`. User sees only first ~5 lines unless they
press ctrl+e. For analyze/summary prompts (the primary use case), this hides
the actual answer.

**Suspected source:** `src/ui/components/message-view.tsx` or similar — has a
default-collapse heuristic for messages above N lines.

**Acceptance options (pick one in plan-phase):**

  - A) Final-response messages (last assistant message in a turn) default to
    expanded; intermediate assistant text messages keep current behavior.
  - B) Raise the collapse threshold to 200+ lines (effectively only collapses
    huge file dumps).
  - C) Remove collapse entirely; rely on terminal scrollback.

---

## Implementation order (proposed)

**Wave 1 (parallel-safe):**
- F4 — discovery filesystem grounding (medium effort, ~1-2h)
- F5 — EE judge no-op suppression (small effort, ~30min)
- F7 — TUI collapse default (small effort, ~30min)

**Wave 2 (depends on F6 investigation):**
- F6 — needs root-cause investigation before fix can be specified.
  Approach: instrument message-processor with stopWhen telemetry, re-run
  the 5-baseline with telemetry on, identify the exact stop trigger.

---

## Out of scope (deferred to Phase 6+)

- Capability-scoped sub-agents (Phase 4 spec exclusion, still valid)
- File-scope quarantine (Aider-style edit gating) — Phase 4 spec exclusion
- "improve coverage" auto-measurement — minor G5 weakness from Phase 4

---

## Open questions for plan-phase

1. F6 root cause: is it the `_sizeCapped` flag, the 4B counter inflation,
   or the model's natural finishReason? Need telemetry first.
2. F7: which option (A/B/C) does user prefer? Default to A (final-response-
   expanded) — least surprising, no scrollback assumptions.
3. F4: should "module suggestions" be globally disabled when the project has
   no obvious module structure (flat repos), or always shown with a
   "filesystem-grounded" caveat?
