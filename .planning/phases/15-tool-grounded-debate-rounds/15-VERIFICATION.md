---
phase: 15-tool-grounded-debate-rounds
verified: 2026-05-08T16:17:00Z
status: passed
score: 13/13 must-haves verified
overrides_applied: 0
---

# Phase 15: Tool-grounded Debate Rounds — Verification Report

**Phase Goal:** Agents actually debate by verifying each other's claims with tools — not by trading prose generated from general knowledge.
**Verified:** 2026-05-08T16:17:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | CouncilLLM interface has a debate() method signature returning { text, toolCalls } | VERIFIED | `src/council/types.ts` line 175 — `debate(` signature exists; return type `Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }>` |
| 2 | LeaderEvaluation has optional evidenceDensity and disagreementResolved fields | VERIFIED | `src/council/types.ts` lines 49, 51 — both fields present as `?:number` |
| 3 | All existing consumers of CouncilLLM and LeaderEvaluation compile without changes | VERIFIED | tsc --noEmit exits 0; 56 council tests pass |
| 4 | llm.debate() exists, calls generateText with tools and stopWhen: stepCountIs(4) | VERIFIED | `src/council/llm.ts` line 62 — `stopWhen: stepCountIs(4)` confirmed; line 38 full method body |
| 5 | debate() returns { text, toolCalls } not bare string | VERIFIED | `src/council/llm.ts` lines 71, 75 — both success and error paths return structured object |
| 6 | buildOpeningPrompt, buildResponsePrompt, buildFollowupPrompt all inject refute-then-cite rule | VERIFIED | `grep -c "REFUTED via" src/council/prompts.ts` → 3 (one per prompt builder) |
| 7 | buildLeaderEvaluationPrompt JSON schema includes evidenceDensity and disagreementResolved fields | VERIFIED | `grep -c "evidenceDensity" src/council/prompts.ts` → 1; `grep -c "disagreementResolved"` → 1 |
| 8 | Opening, response, and follow-up calls use llm.debate() not llm.generate() | VERIFIED | `grep -c "llm\.debate(" src/council/debate.ts` → 4 (all pair loop call sites) |
| 9 | Each round's exchanges persist as [Council Round N] system message | VERIFIED | `grep -c "Council Round" src/council/debate.ts` → 3 (format string + template usage) |
| 10 | evaluateDebate computes evidenceDensity and disagreementResolved | VERIFIED | `grep -c "evidenceDensity" src/council/debate.ts` → 3; `grep -c "countCitations"` → 2 |
| 11 | When evidenceDensity < 0.3 after round >= 2, needsResearch is forced true | VERIFIED | Logic present in debate.ts; covered by evaluator-metrics.test.ts (13 tests, all pass) |
| 12 | planDebate uses generateObject as first attempt with Zod schema and one-retry fallback | VERIFIED | `grep -c "generateObject" src/council/debate-planner.ts` → 5; `grep -c "DebatePlanSchema"` → 3; `grep -c "FALLBACK_PLAN"` → 3 |
| 13 | New test files (round-tools.test.ts + evaluator-metrics.test.ts) pass covering CQ-06–CQ-10 | VERIFIED | `npx vitest run` → 2 test files, 22 tests, 0 failures |

**Score:** 13/13 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/council/types.ts` | Extended CouncilLLM + LeaderEvaluation | VERIFIED | debate() at line 175; evidenceDensity/disagreementResolved at lines 49, 51 |
| `src/council/llm.ts` | debate() implementation | VERIFIED | Full implementation with stepCountIs(4), temp 0.7, maxOutputTokens 2048 |
| `src/council/prompts.ts` | refute-then-cite rule injection + leader eval schema | VERIFIED | 3x REFUTED via; evidenceDensity + disagreementResolved in leader eval JSON |
| `src/council/debate.ts` | llm.debate() callers + per-round persistence + evidence density | VERIFIED | 4 debate() calls; Council Round persistence; countCitations/estimateClaims helpers |
| `src/council/debate-planner.ts` | generateObject-based planDebate with retry | VERIFIED | generateObject attempt 1, tracedGenerate retry, FALLBACK_PLAN fallback |
| `src/council/__tests__/round-tools.test.ts` | Tests for CQ-06, CQ-07, CQ-09 | VERIFIED | 9 tests, all pass |
| `src/council/__tests__/evaluator-metrics.test.ts` | Tests for CQ-08, CQ-10 | VERIFIED | 13 tests, all pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| src/council/llm.ts | src/council/types.ts | CouncilLLM interface | WIRED | debate() stub in Plan 01 replaced with real implementation in Plan 02 |
| src/council/debate.ts | src/council/llm.ts | llm.debate() call | WIRED | 4 call sites in pair exchange loop |
| src/council/debate.ts | LeaderEvaluation.evidenceDensity | countCitations helper | WIRED | evidenceDensity computed and returned in evaluateDebate |
| src/council/prompts.ts | buildOpeningPrompt/buildResponsePrompt/buildFollowupPrompt | EVIDENCE_RULE_* constants | WIRED | 3 separate constants, one injected per builder |
| src/council/debate-planner.ts | FALLBACK_PLAN | two-failure path | WIRED | Both generateObject failure and retry failure return FALLBACK_PLAN |

### Requirements Coverage

| Requirement | Plans | Description | Status | Evidence |
|-------------|-------|-------------|--------|----------|
| CQ-06 | 01, 02, 03, 05 | Debate calls accept/use merged tools (MCP + builtin) | SATISFIED | llm.debate() builds allTools = { ...builtinTools, ...mcpBundle.tools }; stepCountIs(4); 3 tests in round-tools.test.ts |
| CQ-07 | 02, 05 | Stance prompts mandate verify-then-refute; [REFUTED via] citation tags | SATISFIED | 3x EVIDENCE_RULE_* constants injected into prompt builders; 3 tests in round-tools.test.ts |
| CQ-08 | 03, 05 | evaluateDebate computes evidenceDensity; < 0.3 forces needsResearch | SATISFIED | countCitations/estimateClaims helpers; force logic in evaluateDebate; 6 logic+helper tests |
| CQ-09 | 03, 05 | Per-round [Council Round N] persistence | SATISFIED | council_status StreamChunk emitted with [Council Round N] format; 3 persistence tests |
| CQ-10 | 04, 05 | Structured JSON output with one retry before FALLBACK_PLAN | SATISFIED | generateObject → tracedGenerate retry → FALLBACK_PLAN; 3 planner tests |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| round-tools.test.ts passes | npx vitest run src/council/__tests__/round-tools.test.ts | 9/9 tests pass | PASS |
| evaluator-metrics.test.ts passes | npx vitest run src/council/__tests__/evaluator-metrics.test.ts | 13/13 tests pass | PASS |
| Full test suite (22 new tests) | npx vitest run (both files) | 22 passed, 0 failed | PASS |

### Anti-Patterns Found

None. No TODO/FIXME/placeholder patterns found in modified files. Plan 01 stubs in llm.ts were explicitly replaced by Plan 02 implementation (confirmed by grep — debate() now calls generateText with tools, not delegates to generate()).

### Human Verification Required

None. All must-haves verified programmatically.

---

_Verified: 2026-05-08T16:17:00Z_
_Verifier: Claude (gsd-verifier)_
