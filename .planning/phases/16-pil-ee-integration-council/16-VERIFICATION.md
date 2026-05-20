---
phase: 16-pil-ee-integration-council
verified: 2026-05-20T10:05:00Z
status: verified
score: 13/13 must-haves verified
overrides_applied: 0
gaps:
  - truth: "app.tsx registers setActiveEeYield so experience_warning and experience_injected chunks reach TUI render path"
    status: passed
    note: "completed 2026-05-20 — wired in commits 778b190 (16-09) — src/ui/app.tsx imports setActiveEeYield from ../index.js (line 10), registers handler before the stream loop (line 2719) and deregisters in finally (line 2976); experience_warning render branch at line 2935; experience_injected render branch at line 2940."
    reason_historical: "Plan 16-02 Task 3 was never executed. SUMMARY lists only 2 tasks completed (render.ts + index.ts). app.tsx has no import of setActiveEeYield, no register/deregister call, and no render branches for experience_warning or experience_injected."
    artifacts:
      - path: "src/ui/app.tsx"
        issue: "Missing: import setActiveEeYield from ../index.js; setActiveEeYield(handleChunk) call; setActiveEeYield(null) cleanup; experience_warning render branch; experience_injected render branch"
    missing:
      - "Import setActiveEeYield from ../index.js in app.tsx"
      - "Register setActiveEeYield when stream opens"
      - "Deregister setActiveEeYield(null) when stream closes"
      - "Render branch for experience_warning (yellow ⚠ block)"
      - "Render branch for experience_injected (cyan collapsed block)"

  - truth: "runCouncil propagates taskType and complexityTier from PIL ctx to debate-planner"
    status: passed
    note: "completed 2026-05-20 — src/council/debate-planner.ts:83-103 declares optional taskType + complexityTier params and injects them as `## Task Context (from PIL)` block in system prompt; src/council/index.ts:237-245 calls planDebate(spec, leaderModelId, llm, eeResult.warnings, experienceMode, pilCtx?.taskType ?? undefined, pilCtx?.complexityTier ?? undefined)."
    reason_historical: "council/index.ts calls planDebate(spec, leaderModelId, llm, eeResult.warnings, experienceMode) — taskType and complexityTier from pilCtx are NOT passed. debate-planner.ts has no taskType/complexityTier params (grep confirmed no match). Plan 16-04 acceptance criteria required these but they were dropped: the plan spec said pass pilCtx?.taskType and pilCtx?.complexityTier as args 6 and 7 to planDebate."
    artifacts:
      - path: "src/council/index.ts"
        issue: "planDebate call does not include pilCtx?.taskType or pilCtx?.complexityTier args"
      - path: "src/council/debate-planner.ts"
        issue: "planDebate signature has no taskType or complexityTier params"
    missing:
      - "Add taskType?: string and complexityTier?: string params to planDebate signature"
      - "Pass pilCtx?.taskType and pilCtx?.complexityTier from runCouncil to planDebate"
      - "Inject taskType/complexityTier into debate system prompt context"

  - truth: "buildSynthesisPrompt receives outputStyle from PIL ctx so council synthesis tone matches user preference"
    status: passed
    note: "completed 2026-05-20 — src/council/planner.ts:25 accepts outputStyle param (no underscore prefix), line 67 includes it in baseArgs forwarded to buildSynthesisPrompt on both first attempt (line 71) and compact retry (line 106). src/council/index.ts passes pilCtx?.outputStyle to runPlanning at every call site (lines 354, 570, 592, 640, 697)."
    reason_historical: "runPlanning accepts _outputStyle as optional param (prefixed _ = not yet consumed) but passes buildSynthesisPrompt({ spec, finalPositions, allExchanges, debatePlan }) — outputStyle NOT included. The field exists in buildSynthesisPrompt ctx interface and the directive logic is implemented in prompts.ts, but the wiring from runPlanning → buildSynthesisPrompt is missing."
---

# Phase 16: PIL + EE Integration into Council — Verification Report

**Phase Goal:** Integrate PIL pipeline output and EE (Experience Engine) into the council flow — PIL provides task context, EE provides experience warnings that seed the debate and influence synthesis quality.
**Verified:** 2026-05-20T10:05:00Z (re-verification)
**Status:** verified
**Re-verification:** Yes — Gap 1 (CQ-16a) closed by commit `778b190` (plan 16-09); Gap 2 (CQ-11) closed by debate-planner taskType/complexityTier params + council/index.ts forwarding (plan 16-10); Gap 3 (CQ-18) closed by planner.ts passing outputStyle through (plan 16-11).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `queryExperience(topic, domain)` returns `CouncilExperienceResult` with `warnings[]` or empty on VPS unreachable | ✓ VERIFIED | `src/ee/council-bridge.ts` — catch block returns `{ warnings: [], error: String(err) }`; COUNCIL_EE_TIMEOUT_MS=1500 with AbortSignal.timeout |
| 2 | `council.experienceMode` defaults to `"advisory"` via `getCouncilExperienceMode()` | ✓ VERIFIED | `src/utils/settings.ts:825` — `return loadUserSettings().councilExperienceMode ?? "advisory"` |
| 3 | StreamChunk type union includes `experience_warning` and `experience_injected` | ✓ VERIFIED | `src/types/index.ts:326` — both in union; ExperienceWarningData and ExperienceInjectedData interfaces at lines 309/317 |
| 4 | render.ts emitMatches emits StreamChunk (not string) via warningToChunk | ✓ VERIFIED | `src/ee/render.ts:64-67` — emitMatches calls `_sink(warningToChunk(m))`; RenderSink = `string \| StreamChunk` |
| 5 | index.ts boot wires setRenderSink so EE warnings route to active orchestrator stream (CQ-16a partial) | ✓ VERIFIED | `src/index.ts:52,84-90` — setRenderSink called at boot; _activeEeYield guard present |
| 6 | app.tsx registers setActiveEeYield — experience chunks reach TUI render path (CQ-16a full) | ✓ VERIFIED | `src/ui/app.tsx:10` imports `setActiveEeYield`; line 2719 registers handler in main stream try-block, line 2976 deregisters in finally; render branches at lines 2935 (experience_warning ⚠) and 2940 (experience_injected 💡). |
| 7 | PIL Layer 3 injection emits experience_injected StreamChunk on success path (CQ-16b) | ✓ VERIFIED | `src/pil/layer3-ee-injection.ts:124-138` — try-catch block with `type: "experience_injected" as const`; getRenderSink()(injectedChunk as any) |
| 8 | runCouncil invokes runPipeline and propagates taskType + complexityTier to debate-planner (CQ-11) | ✓ VERIFIED | `src/council/index.ts:237-245` calls `planDebate(spec, leaderModelId, llm, eeResult.warnings, experienceMode, pilCtx?.taskType ?? undefined, pilCtx?.complexityTier ?? undefined)`; `src/council/debate-planner.ts:83-103` accepts both params and injects them as `## Task Context (from PIL)` block in the system prompt. |
| 9 | Debate-planner injects experience snippets + Experience Auditor stance (CQ-13, CQ-14) | ✓ VERIFIED | `src/council/debate-planner.ts:86-92` — eeSnippets injected; `injectAuditorStance` helper at line 56; all 3 exit points covered |
| 10 | buildSynthesisPrompt respects outputStyle from PIL ctx (CQ-18) | ✓ VERIFIED | `src/council/planner.ts:25` accepts outputStyle (no underscore), line 67 includes it in baseArgs, line 71/106 forward to `buildSynthesisPrompt`. `src/council/index.ts` lines 354, 570, 592, 640, 697 all pass `pilCtx?.outputStyle ?? undefined` to runPlanning. |
| 11 | Tools in debate rounds wrapped with EE PreToolUse intercept (CQ-15) | ✓ VERIFIED | `src/council/llm.ts:21,91` — wrapToolsWithEeCheck defined; debate method uses it with fail-open try-catch |
| 12 | judgeCouncilOutcome fires post-synthesis; NEEDS HUMAN REVIEW flag at confidence < 0.5 (CQ-16) | ✓ VERIFIED | `src/council/index.ts:264-279` — `void judgeCouncilOutcome(synthesisText).then(...)` pattern; NEEDS HUMAN REVIEW appendSystemMessage |
| 13 | recordCouncilOutcome fire-and-forget to EE brain (CQ-17) | ✓ VERIFIED | `src/ee/phase-outcome.ts:141` — `void firePhaseOutcome(...).catch(()=>{})` |
| 14 | checkEEDetailed reports ee.health with mode/circuit/server sub-status (CQ-16c) | ✓ VERIFIED | `src/ops/doctor.ts:126-161` — checkEEDetailed uses healthDetailed(); name="ee.health"; VPS hint at "experience.muonroi.com" |
| 15 | checkBrainEmptiness warns with bootstrap hint at >= 50 no_match events (CQ-16d) | ✓ VERIFIED | `src/ops/doctor.ts:171-216` — BRAIN_EMPTY_THRESHOLD=50; SQL query on ee_injection/no_match; "experience extract" hint |
| 16 | 18 regression tests pass (CQ-16a/b/c/d) | ✓ VERIFIED | `bunx vitest run` — 3 files, 18/18 tests pass: render-sink-wiring(6), doctor-ee-health(8), layer3-injected-chunk(4) |

**Score:** 13/13 primary truths verified (all 3 historical gaps closed as of 2026-05-20)

Note: Truths #5 and #6 split CQ-16a: boot-level wiring (#5, src/index.ts) and TUI app.tsx integration (#6) are both verified.

---

### Requirement Coverage

| Requirement | Plan | Description | Status | Evidence |
|-------------|------|-------------|--------|----------|
| CQ-11 | 16-04 | runPipeline invoked; taskType/domain/outputStyle/grayAreas propagated to debate-planner | SATISFIED | runPipeline called; taskType/complexityTier/domain/outputStyle/grayAreas all propagated (closed by plan 16-10 on 2026-05-20) |
| CQ-12 | 16-01 | council-bridge.ts queryExperience; degrades gracefully | SATISFIED | src/ee/council-bridge.ts fully implemented with 1.5s cap and fail-open |
| CQ-13 | 16-05 | Debate-planner injects experience snippets into stance generation | SATISFIED | eeSnippets injection verified in debate-planner.ts |
| CQ-14 | 16-05 | Experience Auditor stance auto-added when >= 1 warning | SATISFIED | injectAuditorStance helper; advisory/enforcing modes both implemented |
| CQ-15 | 16-06 | wrapToolWithEeCheck wraps debate tools | SATISFIED | wrapToolsWithEeCheck in council/llm.ts |
| CQ-16 | 16-06 | judgeOutcome confidence scoring; < 0.5 → NEEDS HUMAN REVIEW | SATISFIED | judgeCouncilOutcome heuristic + appendSystemMessage |
| CQ-17 | 16-06 | recordCouncilOutcome fire-and-forget to EE brain | SATISFIED | phase-outcome.ts recordCouncilOutcome; .catch(() => {}) |
| CQ-18 | 16-05 | Synthesis respects ctx.outputStyle | SATISFIED | planner.ts forwards outputStyle in baseArgs to buildSynthesisPrompt on first attempt + compact retry; runCouncil passes pilCtx?.outputStyle at all runPlanning call sites (closed by plan 16-11 on 2026-05-20) |
| CQ-19 | 16-01 | council.experienceMode = off/advisory/enforcing feature flag | SATISFIED | CouncilExperienceMode type; getCouncilExperienceMode(); defaults to "advisory" |
| CQ-16a | 16-02 | setRenderSink wired at boot; experience_warning blocks in TUI | SATISFIED | Boot wiring done (index.ts) + app.tsx Task 3 closed by plan 16-09: setActiveEeYield registered/deregistered around main stream loop; experience_warning + experience_injected render branches present |
| CQ-16b | 16-03 | experience_injected StreamChunk on Layer 3 success | SATISFIED | layer3-ee-injection.ts emits chunk; test suite verifies |
| CQ-16c | 16-07 | doctor checks EE thin-client health with sub-status | SATISFIED | checkEEDetailed; ee.health; mode/circuit/server/gates detail |
| CQ-16d | 16-07 | Brain-emptiness diagnostic in doctor | SATISFIED | checkBrainEmptiness; BRAIN_EMPTY_THRESHOLD=50; "experience extract" hint |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/ee/council-bridge.ts` | queryExperience thin-client function | ✓ VERIFIED | 97 lines; exports queryExperience, CouncilExperienceResult, CouncilWarning |
| `src/utils/settings.ts` | CouncilExperienceMode + getCouncilExperienceMode | ✓ VERIFIED | Type at line 24; field at 202; accessor at 825 |
| `src/types/index.ts` | experience_warning/experience_injected StreamChunk types | ✓ VERIFIED | Union extended at line 326; ExperienceWarningData/ExperienceInjectedData interfaces at 309/317 |
| `src/ee/render.ts` | Extended RenderSink; warningToChunk helper | ✓ VERIFIED | RenderSink = string\|StreamChunk; warningToChunk exported; emitMatches → StreamChunk |
| `src/index.ts` | Boot wiring of setRenderSink | ✓ VERIFIED | setRenderSink called; _activeEeYield + setActiveEeYield present |
| `src/ui/app.tsx` | setActiveEeYield registration; experience_* render branches | ✓ VERIFIED | Import at line 10; register at line 2719; deregister at line 2976; experience_warning branch at line 2935; experience_injected branch at line 2940 (closed 2026-05-20) |
| `src/pil/layer3-ee-injection.ts` | experience_injected chunk on success path | ✓ VERIFIED | try-catch block; getRenderSink()(injectedChunk as any) |
| `src/council/index.ts` | runPipeline + eePromise + judgeCouncilOutcome | ✓ VERIFIED | All three present; taskType/complexityTier passed to planDebate (lines 237-245); outputStyle threaded into runPlanning at all call sites |
| `src/council/debate-planner.ts` | planDebate with eeWarnings + Experience Auditor | ✓ VERIFIED | injectAuditorStance helper; all exit points covered |
| `src/council/prompts.ts` | buildSynthesisPrompt with outputStyle | ✓ VERIFIED | outputStyle param + directive logic intact; planner.ts now threads it through baseArgs to both attempts (first + compact retry) |
| `src/ee/judge.ts` | judgeCouncilOutcome heuristic scoring | ✓ VERIFIED | CouncilJudgeResult; confidence scoring with 5 heuristics |
| `src/ee/phase-outcome.ts` | recordCouncilOutcome fire-and-forget | ✓ VERIFIED | void firePhaseOutcome(...).catch(()=>{}) |
| `src/council/llm.ts` | wrapToolsWithEeCheck | ✓ VERIFIED | Function defined + applied in debate method |
| `src/ops/doctor.ts` | checkEEDetailed + checkBrainEmptiness | ✓ VERIFIED | Both functions present; checkEE() removed |
| `src/ee/__tests__/render-sink-wiring.test.ts` | 6 regression tests | ✓ VERIFIED | 6 tests PASS |
| `src/ops/__tests__/doctor-ee-health.test.ts` | 8 regression tests | ✓ VERIFIED | 8 tests PASS |
| `src/pil/__tests__/layer3-injected-chunk.test.ts` | 4 regression tests | ✓ VERIFIED | 4 tests PASS |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `council/index.ts` | `pil/pipeline.ts:runPipeline` | await runPipeline(topic, {sessionId}) | ✓ WIRED | Line 90 confirmed |
| `council/index.ts` | `ee/council-bridge.ts:queryExperience` | eePromise = queryExperience(topic, pilCtx?.domain) | ✓ WIRED | Lines 97-100 confirmed |
| `council/index.ts` | `ee/judge.ts:judgeCouncilOutcome` | void judgeCouncilOutcome(synthesisText).then(...) | ✓ WIRED | Line 264 confirmed |
| `council/index.ts` | `council/debate-planner.ts:planDebate` | planDebate(spec, ..., eeResult.warnings, experienceMode, taskType, complexityTier) | ✓ WIRED | All 7 args passed; debate-planner.ts injects taskType/complexityTier into system prompt PIL block |
| `council/planner.ts` | `council/prompts.ts:buildSynthesisPrompt` | buildSynthesisPrompt({...outputStyle}) | ✓ WIRED | outputStyle included in baseArgs (planner.ts:67) forwarded on both first attempt + compact retry |
| `src/index.ts` | `ee/render.ts:setRenderSink` | setRenderSink at boot → _activeEeYield | ✓ WIRED | Lines 52, 84-90 confirmed |
| `src/ui/app.tsx` | `src/index.ts:setActiveEeYield` | setActiveEeYield(handleChunk) on stream open | ✓ WIRED | Registered at line 2719 (try-block before processMessage loop), deregistered at line 2976 (finally) |
| `pil/layer3-ee-injection.ts` | `ee/render.ts:getRenderSink` | getRenderSink()(injectedChunk as any) | ✓ WIRED | Lines 14, 138 confirmed |
| `ee/phase-outcome.ts:recordCouncilOutcome` | firePhaseOutcome | void firePhaseOutcome(...).catch(()=>{}) | ✓ WIRED | Fire-and-forget confirmed |

---

### Behavioral Spot-Checks

| Behavior | Evidence | Status |
|----------|----------|--------|
| render-sink-wiring: emitMatches emits StreamChunk type | 6 vitest tests PASS | ✓ PASS |
| doctor ee.health + ee.brain checks | 8 vitest tests PASS | ✓ PASS |
| layer3 experience_injected chunk on success | 4 vitest tests PASS | ✓ PASS |
| app.tsx renders experience_warning as ⚠ block in TUI | src/ui/app.tsx:2935 case "experience_warning" with applyLocalAssistantDelta(`⚠ [Experience] …`) | ✓ PASS |
| outputStyle directive prepended to synthesis system prompt | planner.ts:67 includes outputStyle in baseArgs; prompts.ts styleDirective consumed | ✓ PASS |

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `src/pil/layer3-ee-injection.ts:138` | `getRenderSink()(injectedChunk as any)` — `as any` cast | ⚠ Warning | Type safety lost; Wave 1 parallel compat cast never removed post-merge |
| `src/council/planner.ts:25` | `_outputStyle` param prefixed with `_` (not yet consumed) | ⚠ Warning | Signals intent-not-consumed; CQ-18 broken because of this |

---

### Human Verification Required

None — all failures identified programmatically.

---

### Gaps Summary

**Status as of 2026-05-20: all three gaps closed.** Phase 16 fully verified.

Historical context (gaps as identified at 2026-05-08):

**Gap 1 (CQ-16a BLOCKER):** `app.tsx` Task 3 from plan 16-02 was never executed. The SUMMARY for plan 16-02 documents only 2 tasks completed. While `setActiveEeYield` is exported from `src/index.ts` and the sink infrastructure is fully built, it is never called from the TUI. As a result, `experience_warning` and `experience_injected` StreamChunks are routed to `_activeEeYield` which is always `null` in practice — they are silently dropped. The EE warnings never appear in the chat UI.

**Gap 2 (CQ-11 PARTIAL):** `runCouncil` correctly calls `runPipeline` and pre-fetches EE warnings, but `pilCtx.taskType` and `pilCtx.complexityTier` are NOT forwarded to `planDebate`. The acceptance criteria in plan 16-04 required this (`planDebate call passes "pilCtx?.taskType"` and `"pilCtx?.complexityTier"`), but the actual call is `planDebate(spec, leaderModelId, llm, eeResult.warnings, experienceMode)` — 5 args, not 7. The debate-planner cannot calibrate stances by task complexity.

**Gap 3 (CQ-18 PARTIAL):** `buildSynthesisPrompt` has the `outputStyle` parameter and full directive logic (lines 343-377 in prompts.ts), but `runPlanning` receives it as `_outputStyle` (underscore prefix = "not yet consumed") and calls `buildSynthesisPrompt({ spec, finalPositions, allExchanges, debatePlan })` without passing it. Synthesis tone is always the default regardless of PIL Layer 6 output style.

Gaps 2 and 3 share a root cause: plan 16-04 used `_`-prefixed params as a forward-compat stub ("pending plan 16-05/16-06 consumption") but the consuming plans (16-05, 16-06) did not follow through on removing the underscores and wiring the values.

---

_Initially verified: 2026-05-08T17:20:00Z (3 gaps identified)_
_Re-verified: 2026-05-20T10:05:00Z (all 3 gaps closed via plans 16-09/10/11; verified 13/13)_
_Verifier: Claude (gsd-verifier)_
