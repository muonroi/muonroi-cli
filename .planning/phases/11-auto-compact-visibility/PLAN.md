# Phase 11: Auto-Compact Visibility & Efficiency

## Goal
Fix 4 weaknesses in auto-compact to give users visibility into compaction savings, eliminate wasteful LLM calls, and make the system self-evidently working.

## Depends on
- Phase 10 (all previous phases — compaction infrastructure is stable)

## Problem Analysis

### Weakness 1 — No feedback to user (Impact: HIGH)
`compactForContext()` runs silently — zero output, zero status update.
- User sees `↑9.4M ↓34.3K $1.30` in status bar and interprets it as "context is 9.4M tokens"
- Reality: those are **accumulated** lifetime tokens, not current context
- User doesn't know if compact happened, how many tokens were saved, or what current context size is

### Weakness 2 — `force=true` wastes LLM calls (Impact: HIGH)
`postTurnCompact()` always calls `compactForContext(..., true)`.
- Guard: `tokens < 2000` only
- With context window 200K, if tokens = 3000, still calls LLM to summarize
- Summarization costs $ + latency for near-zero benefit

### Weakness 3 — Status bar shows accumulated only (Impact: MEDIUM)
- `in_tokens` / `out_tokens` / `session_usd` are **accumulated**
- No `ctx_tokens` field showing current context size
- User can't verify compact is working from status bar alone

### Weakness 4 — Errors swallowed silently (Impact: LOW)
- `.catch(() => {})` swallows all errors
- `_compactedThisTurn` not set on failure → retry on next turn (acceptable)

### Weakness 5 — Stats leak across sessions (Impact: MEDIUM, found by council)
- `/clear` does NOT reset `ctx_tokens` or `_compactionStats`
- After starting a new session, stale values remain until next compaction

### Weakness 6 — Threshold not configurable (Impact: LOW, found by council)
- 2% hardcoded in `postTurnCompact()`
- Users who want more/less aggressive compaction cannot tune it

---

## Solutions (Upgraded via Council Discussion)

### Fix 1: `ctx_tokens` + `compaction_summary` in status bar
**Files:** `orchestrator.ts`, `store.ts`, `index.tsx`

After compaction, push to status bar store:
- `ctx_tokens` — current context size (e.g., `[ctx: 15K]`)
- `compaction_summary` — string like `"3 cmp, 45K saved"` → shown as `[3 cmp, 45K saved]`

### Fix 2: Smart threshold with configurable percentage
**Files:** `settings.ts`, `orchestrator.ts`

- New setting `autoCompactThresholdPct` in `UserSettings` (default 0.02, range 0.01-0.10)
- Getter `getAutoCompactThresholdPct()` with validation + clamping
- `postTurnCompact()` reads from getter instead of hardcoded `0.02`

### Fix 3: Reset state on new session
**Files:** `orchestrator.ts`

`startNewSession()` now also resets:
- `ctx_tokens: 0`
- `compaction_summary: undefined`
- `this._compactionStats = { count: 0, totalSaved: 0 }`

### Fix 4: Warning log on failure
**File:** `orchestrator.ts`

Replace `.catch(() => {})` with `.catch((err) => console.warn("[compact] failed:", ...))`
at `postTurnCompact()` call site.

### Fix 5: Public getter for stats
**File:** `orchestrator.ts`

`getCompactionStats(): { count: number; totalSaved: number }` — returns a copy of `_compactionStats`.

---

## Implementation Plan

### Wave 1 — Settings (settings.ts)
1. Add `autoCompactThresholdPct?: number` to `UserSettings`
2. Add `getAutoCompactThresholdPct()` getter with validation (0.01-0.10, default 0.02)

### Wave 2 — Core logic (orchestrator.ts)
3. Add `_compactionStats` property to Agent class
4. Add stats tracking in `compactForContext()` (tokensAfter, saved, update `_compactionStats`)
5. Push `ctx_tokens` and `compaction_summary` to status bar store after compaction
6. Update `postTurnCompact()`: read threshold from getter, warning log on failure
7. Import `getAutoCompactThresholdPct` from settings

### Wave 3 — Session lifecycle (orchestrator.ts)
8. Reset `ctx_tokens`, `compaction_summary`, `_compactionStats` in `startNewSession()`

### Wave 4 — Status bar UI (store.ts + index.tsx)
9. Add `ctx_tokens?: number` and `compaction_summary?: string` to `StatusBarState`
10. Display `[ctx: 15K] [3 cmp, 45K saved]` alongside accumulated tokens

### Wave 5 — Public API (orchestrator.ts)
11. Add `getCompactionStats()` public getter

---

## Council Verdict (per fix)

| Fix | Research | Implement | Verify | Final |
|-----|----------|-----------|--------|-------|
| ctx_tokens in status bar | Identified gap | Proposed | ACCEPT | DONE |
| compaction_summary in status bar | Identified missing | Proposed | MODIFY to single string | DONE |
| Smart threshold (configurable) | Recommended | Proposed with validation | ACCEPT | DONE |
| Reset on new session | Found bug | Proposed exact code | ACCEPT | DONE |
| Warning log on failure | Recommended | Proposed | ACCEPT | DONE |
| Proactive notification (console.log) | Recommended | Proposed | REJECT (TUI clash) → debug trace | SKIPPED (trace not accessible from compactForContext) |
| Public getter for stats | Not discussed | Proposed | Not reviewed | DONE |

## Files Changed (Final)
| File | Change |
|------|--------|
| `src/orchestrator/orchestrator.ts` | 5 changes: stats tracking, threshold, reset, warning log, getter |
| `src/ui/status-bar/store.ts` | New `ctx_tokens` + `compaction_summary` fields |
| `src/ui/status-bar/index.tsx` | Display `[ctx: ...]` + `[compaction summary]` |
| `src/utils/settings.ts` | New `autoCompactThresholdPct` setting + getter |

## Final status bar output
```
claude/sonnet | [balanced] | ↑1.2K ↓3.4K [ctx: 15K] [3 cmp, 45K saved] $0.0123 | ▓░░░░░░░░░ 7% | ●
```

## Test Plan
- Unit test: `getAutoCompactThresholdPct()` with valid/invalid/omitted values
- Unit test: `startNewSession()` resets `ctx_tokens`, `compaction_summary`, `_compactionStats`
- Unit test: `getCompactionStats()` returns a copy of stats
- Integration: status bar display after compaction
