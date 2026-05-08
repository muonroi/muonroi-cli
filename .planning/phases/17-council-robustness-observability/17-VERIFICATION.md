---
phase: 17-council-robustness-observability
verified: 2026-05-08T22:01:37Z
status: passed
score: 10/10 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 8/10
  gaps_closed:
    - "CQ-23 dedicated test passes — vi.hoisted() fix resolves TDZ error, all 6 doctor-council-mcp tests now pass"
    - "E2E test asserts council memory contains docs/* AND Tavily citation AND Playwright snapshot — three separate expect().toContain() assertions replace OR logic"
  gaps_remaining: []
  regressions: []
---

# Phase 17: Council Robustness & Observability — Verification Report

**Phase Goal:** Make the council self-auditable, give the user a way to inspect any past debate, and let `doctor` catch missing MCP configuration before it bites.
**Verified:** 2026-05-08T22:01:37Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | parseOutcome logs raw synthesis text to console.error on JSON parse failure | VERIFIED | `console.error("[Council] parseOutcome failed — raw synthesis text:", synthesisText)` at planner.ts:188; 5/5 tests pass |
| 2 | parseOutcome tries shape-based fallback using debatePlan.outputShape.sections before returning null | VERIFIED | `shapeFallback()` at planner.ts:132-148; called at planner.ts:191; test Test 3 passes |
| 3 | Every tool call in llm.debate() is appended as [Council Tool Trace] system message via emit callback | VERIFIED | `emitToolTrace()` at llm.ts:25-36; called at llm.ts:131; 6/6 tool-trace tests pass |
| 4 | Every tool call in llm.research() is appended as [Council Tool Trace] system message via emit callback | VERIFIED | `emitToolTrace()` called at llm.ts:187; test Test 4 passes |
| 5 | Tool trace entries are truncated to 2KB per arg/result | VERIFIED | `TRACE_ARG_LIMIT = 2048` at llm.ts:18; truncate() at llm.ts:22; test Test 2 & 3 pass |
| 6 | /council inspect <session-id> is registered and delegates from council.ts | VERIFIED | council.ts:3 imports handleCouncilInspectSlash; council.ts:8 delegates args[0]==="inspect"; council-inspect.ts exists |
| 7 | council-inspect menu entry appears in SLASH_MENU_ITEMS | VERIFIED | grep -c "council-inspect" menu-items.ts = 1 |
| 8 | checkCouncilMcpNudge added to doctor.ts and wired into runDoctor() | VERIFIED | Function exists at doctor.ts:263; wired at doctor.ts:367; grep -c = 2 |
| 9 | CQ-23 dedicated test passes — checkCouncilMcpNudge behavior verified by test suite | VERIFIED | vi.hoisted() fix applied; all 6 doctor-council-mcp.test.ts tests pass (0 hoisting errors) |
| 10 | E2E test asserts council memory contains docs/* AND Tavily citation AND Playwright snapshot of localhost:3010 | VERIFIED | audit-replay.test.ts lines 297-299 use three separate expect().toContain() for docs/, tavily, snapshot — AND semantics enforced; all 4 tests pass |

**Score:** 10/10 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/council/planner.ts` | parseOutcome with logging + shape-fallback | VERIFIED | shapeFallback at line 132, parseOutcome at 150, console.error at 188 |
| `src/council/llm.ts` | research() and debate() emit [Council Tool Trace] | VERIFIED | emitToolTrace at 25, TRACE_ARG_LIMIT=2048 at 18, wired at 131 and 187 |
| `src/council/debate.ts` | runDebate passes persistTrace callback to llm calls | VERIFIED | traces collected per chunk at lines 163/185/198/212/225; yielded as council_status at 252 |
| `src/council/types.ts` | ToolTraceEmitter exported | VERIFIED | Line 172: `export type ToolTraceEmitter = (traceText: string) => void` |
| `src/ui/slash/council-inspect.ts` | handleCouncilInspectSlash handler | VERIFIED | File exists, exports handler, queries DB with parameterized SQL |
| `src/ui/slash/menu-items.ts` | council-inspect entry in SLASH_MENU_ITEMS | VERIFIED | grep count = 1 |
| `src/ops/doctor.ts` | checkCouncilMcpNudge in runDoctor() | VERIFIED | Function exists, wired in Promise.all |
| `docs/Council.md` | 10 phases A-J documented, PIL + worked example | VERIFIED | All phases A-J present; grep PIL=7, EE Judge=3, Council Tool Trace=6 |
| `README.md` | Link to docs/Council.md | VERIFIED | Line 142 contains `docs/Council.md` link |
| `src/council/__tests__/parse-outcome-fallback.test.ts` | 5 tests passing | VERIFIED | 5/5 pass |
| `src/council/__tests__/tool-trace.test.ts` | 6 tests passing | VERIFIED | 6/6 pass |
| `src/ops/__tests__/doctor-council-mcp.test.ts` | 6 tests passing | VERIFIED | vi.hoisted() fix: all 6 tests pass, 0 hoisting errors |
| `src/council/__tests__/audit-replay.test.ts` | 4 tests passing with AND evidence assertion | VERIFIED | 4/4 pass; AND semantics via 3 separate toContain() assertions |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `src/council/debate.ts` | `src/council/llm.ts` | persistTrace callback injected into llm.debate() | WIRED | debate.ts:163-225 collects aTraces/bTraces; passes (t) => aTraces.push(t) to llm.debate |
| `src/council/planner.ts` | parseOutcome | shape-based fallback when JSON parse fails | WIRED | planner.ts:190-192 calls shapeFallback when outputShape present |
| `src/ops/doctor.ts` | `~/.muonroi-cli/muonroi.db` | getDatabase().prepare() selecting [Council Memory] messages | WIRED | doctor.ts:289-295 queries messages table with LIMIT 50 |
| `src/ops/doctor.ts` | `src/utils/settings.ts` | loadMcpServers() to check enabled MCP list | WIRED | doctor.ts:265-273 calls loadMcpServers() and checks id/label/command |
| `src/ui/slash/council-inspect.ts` | `~/.muonroi-cli/muonroi.db` | getDatabase().prepare() querying messages table for session_id | WIRED | council-inspect.ts queries `WHERE session_id = ?` parameterized |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `src/council/planner.ts:parseOutcome` | synthesisText | caller passes LLM output | Yes — real text | FLOWING |
| `src/ops/doctor.ts:checkCouncilMcpNudge` | rows (Council Memory messages) | SQLite query with LIMIT 50 | Yes — DB query | FLOWING |
| `src/ui/slash/council-inspect.ts` | rows (session messages) | getDatabase().prepare(sql).all(sessionId) | Yes — DB query | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| parseOutcome fallback tests | bunx vitest run src/council/__tests__/parse-outcome-fallback.test.ts | 5 pass, 0 fail | PASS |
| tool-trace tests | bunx vitest run src/council/__tests__/tool-trace.test.ts | 6 pass, 0 fail | PASS |
| doctor-council-mcp tests | bunx vitest run src/ops/__tests__/doctor-council-mcp.test.ts | 6 pass, 0 fail | PASS |
| audit-replay tests | bunx vitest run src/council/__tests__/audit-replay.test.ts | 4 pass, 0 fail | PASS |
| combined gap-closure run | bunx vitest run src/ops/__tests__/doctor-council-mcp.test.ts src/council/__tests__/audit-replay.test.ts | 10 pass, 0 fail | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| CQ-20 | 17-01 | parseOutcome raw log + shape-based fallback | SATISFIED | planner.ts:188-192; 5 tests pass |
| CQ-21 | 17-02 | /council inspect slash command | SATISFIED | council-inspect.ts exists; delegation wired; menu entry added |
| CQ-22 | 17-01 | [Council Tool Trace] persistence with 2KB truncation | SATISFIED | llm.ts emitToolTrace; debate.ts yields council_status; 6 tests pass |
| CQ-23 | 17-03 | doctor council.mcp nudge check | SATISFIED | Implementation in doctor.ts correct; 6 dedicated tests pass after vi.hoisted() fix |
| CQ-24 | 17-04 | docs/Council.md with worked example + README link | SATISFIED | docs/Council.md exists with all 10 phases; README linked; audit-replay test passes with AND assertion for all 3 evidence signals |

### Anti-Patterns Found

None. Previously identified blockers resolved:
- `doctor-council-mcp.test.ts`: vi.hoisted() pattern applied — mock variables declared in hoisted scope, no TDZ errors
- `audit-replay.test.ts`: OR assertion replaced by three independent `expect().toContain()` calls — AND semantics verified

### Human Verification Required

None. All verifications are deterministic and confirmed programmatically.

### Gaps Summary

No gaps remaining. All 10 must-haves verified. Phase 17 goal achieved.

---

_Verified: 2026-05-08T22:01:37Z_
_Verifier: Claude (gsd-verifier)_
