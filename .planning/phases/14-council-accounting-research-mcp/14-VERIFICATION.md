---
phase: 14-council-accounting-research-mcp
verified: 2026-05-08T09:00:00Z
status: passed
score: 10/10 must-haves verified
overrides_applied: 0
re_verification: null
gaps: []
deferred: []
human_verification: []
---

# Phase 14: Council Accounting & Research MCP Wiring — Verification Report

**Phase Goal:** Fix 5 structural council bugs (CQ-01 through CQ-05) identified in audit of council session 1b4f7528ddc8
**Verified:** 2026-05-08T09:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `DebateState` interface has an `active: CouncilParticipant[]` field | VERIFIED | `src/council/types.ts:56` — field present with comment `// mutated positions from debate rounds — NEW (Phase 14 CQ-02)` |
| 2 | `RunCouncilOptions` interface has a `councilStats?: CouncilStats` field | VERIFIED | `src/council/index.ts:31` — field present with comment describing CQ-01 fix |
| 3 | `runDebate` return value includes the `active` array (both return paths) | VERIFIED | `src/council/debate.ts:129` — early-exit return: `return { spec, exchangeLogs, runningSummary: "", roundCount: 0, researchFindings, active }` / line 361 main return: same |
| 4 | `runCouncil` reads finalPositions from `debateState.active`, not its local `active` | VERIFIED | `src/council/index.ts:201,226,227` — `debateState.active` used in runPlanning call AND for `participants` AND `finalPositions` (3 occurrences) |
| 5 | `runCouncil` uses `options?.councilStats` when provided | VERIFIED | `src/council/index.ts:45` — `const stats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] }` |
| 6 | `orchestrator.ts` passes `councilStats` into `runCouncil` options | VERIFIED | `src/orchestrator/orchestrator.ts:2067` — `councilStats,` present in options object with comment |
| 7 | `research()` merges MCP tools with builtin tools | VERIFIED | `src/council/llm.ts:54` — `const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) }` |
| 8 | MCP spawn failures do not crash research — fail-open with builtin tools only | VERIFIED | `src/council/llm.ts:47-52` — try/catch wraps `buildMcpToolSet`, `finally` calls `mcpBundle?.close()` |
| 9 | URL detection appends gap annotation when browser tool not invoked | VERIFIED | `src/council/llm.ts:57,78-93` — `/https?:\/\/\S+/.test(topic)` + checks `result.toolCalls` for playwright/chrome; appends `## Research Gap` |
| 10 | Research output uses 3-section template via `buildResearchSystemPrompt` | VERIFIED | `src/council/prompts.ts:349-372` — all 3 headings: `## Source Code Findings`, `## Internet Findings`, `## Frontend Findings (live)` with citation formats |

**Score:** 10/10 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/council/types.ts` | `DebateState.active` field + `CouncilStats` interface | VERIFIED | Line 56: `active: CouncilParticipant[]` present; CouncilStats at lines 160-164 |
| `src/council/index.ts` | `RunCouncilOptions.councilStats` + uses `options?.councilStats` | VERIFIED | Line 31: field in interface; line 45: usage with `??` fallback |
| `src/council/debate.ts` | Both DebateState returns include `active` | VERIFIED | Line 129 (early-exit) and line 361 (main return) both include `active` |
| `src/orchestrator/orchestrator.ts` | `councilStats` passed to `runCouncil` | VERIFIED | Line 2067: `councilStats,` in options object |
| `src/council/prompts.ts` | `buildResearchSystemPrompt(hasUrl)` exported | VERIFIED | Line 349: function exported, full 3-section template at lines 356-372 |
| `src/council/llm.ts` | `research()` with MCP wiring + URL detection | VERIFIED | Lines 46-107: MCP bundle, tool merge, URL detection, gap annotation, close() in finally |
| `src/council/__tests__/accounting.test.ts` | Tests for CQ-01 and CQ-02 | VERIFIED | File exists, 4 tests covering type-level and behavioral contracts for both bugs |
| `src/council/__tests__/research-tools.test.ts` | Tests for CQ-03, CQ-04, CQ-05 | VERIFIED | File exists, 8 tests: 4 for CQ-05 (pure function), 2 for CQ-04 (integration mock), 2 for CQ-03 (integration mock) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/council/debate.ts` | `src/council/types.ts` | DebateState return type — `active` field | WIRED | Both return paths include `active`; type satisfied by Plan 01 contract |
| `src/council/index.ts` | `src/council/debate.ts` | `debateState.active` read from runDebate return | WIRED | Line 201, 226, 227 use `debateState.active` |
| `src/orchestrator/orchestrator.ts` | `src/council/index.ts` | `councilStats` passed in RunCouncilOptions | WIRED | Line 2067: `councilStats,` in options |
| `src/council/llm.ts` | `src/mcp/runtime.ts` | `buildMcpToolSet(loadMcpServers())` | WIRED | Lines 9-10 import; line 49 call |
| `src/council/llm.ts` | `src/council/prompts.ts` | `import buildResearchSystemPrompt` | WIRED | Line 12 import; line 58 call |
| `src/council/llm.ts` | `ai` | `result.toolCalls` for browser detection | WIRED | Lines 80-84: `result.toolCalls.some(tc => tc.toolName.includes("playwright")||tc.toolName.includes("chrome"))` |
| `src/council/__tests__/research-tools.test.ts` | `src/council/prompts.ts` | direct import `buildResearchSystemPrompt` | WIRED | Line 2: static import (not dynamic fallback — upgraded from Plan 02 spec) |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `src/council/index.ts` finalPositions | `debateState.active` | `runDebate` return value — mutated during rounds | Yes — positions updated per-round in debate.ts lines 200-210 | FLOWING |
| `src/council/index.ts` stats.calls | `options?.councilStats` | orchestrator's shared object (line 2049); also mutated by `createCouncilLLM.generate` and `research()` | Yes — `stats.calls++` on every LLM call | FLOWING |
| `src/council/llm.ts` allTools | `buildMcpToolSet(loadMcpServers())` | MCP runtime; fails-open to `{}` on error | Yes — builtins always populated; MCP tools merged when available | FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — requires live LLM API keys and MCP server processes. Integration-level behavior is covered by vitest mock tests in `research-tools.test.ts` (CQ-03/CQ-04/CQ-05 mocked end-to-end) and accounting tests (CQ-01/CQ-02 type + behavioral).

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| CQ-01 | 14-01, 14-03 | `stats.calls` always 0 (shared councilStats not passed to runCouncil) | SATISFIED | `index.ts:45` uses `options?.councilStats ??`; orchestrator passes it at line 2067; `createCouncilLLM` increments shared object |
| CQ-02 | 14-01, 14-03 | `finalPositions` always empty (debate.ts doesn't return active array) | SATISFIED | `debate.ts:129,361` both return `active`; `index.ts:226-227` reads from `debateState.active` |
| CQ-03 | 14-04 | MCP tools not available to research role | SATISFIED | `llm.ts:49,54` — `buildMcpToolSet` called per-research; merged via spread |
| CQ-04 | 14-04 | No URL detection or gap annotation | SATISFIED | `llm.ts:57` URL regex; lines 78-93 gap annotation appended when browser not invoked |
| CQ-05 | 14-04 | No structured 3-section output template for research | SATISFIED | `prompts.ts:349-372` — `buildResearchSystemPrompt` with all 3 sections and citation formats |

---

### Anti-Patterns Found

None. Scan results:

- No `TODO/FIXME/PLACEHOLDER` in modified files
- No `return null` / `return {}` stubs in production code paths
- `stats.calls++` is called before early returns (URL gap path at line 86 AND normal path at line 96) — not missing calls
- `mcpBundle?.close()` in `finally` — no resource leak
- `result.toolCalls ?? []` — defensive null handling, not a stub

---

### Human Verification Required

None — all behavioral contracts are covered by unit/integration tests with mocks. No UI, real-time, or external service behavior to verify at this phase.

---

### Gaps Summary

No gaps. All 5 bugs (CQ-01 through CQ-05) are fixed and verified in the codebase:

- **CQ-01:** `councilStats` shared reference flows from orchestrator through `RunCouncilOptions` into `runCouncil`, fixing the "always 0 calls" bug.
- **CQ-02:** `debate.ts` returns `active` in both return paths; `index.ts` reads from `debateState.active` for `finalPositions`, fixing the "always empty positions" bug.
- **CQ-03:** `research()` lazily spawns MCP clients, merges their tools with builtins, and closes them in a `finally` block.
- **CQ-04:** URL regex detects `https?://` topics; `result.toolCalls` is checked post-call; `## Research Gap` annotation appended when browser tool absent.
- **CQ-05:** `buildResearchSystemPrompt()` enforces a 3-section output template with mandatory citation formats `[file:line]`, `[url]`, `[snapshot:uid]`.

---

_Verified: 2026-05-08T09:00:00Z_
_Verifier: Claude (gsd-verifier)_
