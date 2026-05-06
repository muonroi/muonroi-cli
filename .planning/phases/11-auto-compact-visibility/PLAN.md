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

**Current code path:**
- `orchestrator.ts:1881` — `generateCompactionSummary()` succeeds
- `orchestrator.ts:1883-1884` — messages replaced silently
- No log, no status bar update, no conversation output

### Weakness 2 — `force=true` wastes LLM calls (Impact: HIGH)
`postTurnCompact()` always calls `compactForContext(..., true)`.
- Guard: `tokens < 2000` only (dòng 1908)
- With context window 200K, if tokens = 3000, still calls LLM to summarize
- Summarization costs $ + latency for near-zero benefit

**Current code:**
```ts
private async postTurnCompact(provider, system, contextWindow, signal) {
    if (this._compactedThisTurn) return;
    if (!isAutoCompactAfterTurnEnabled()) return;
    const tokens = estimateConversationTokens(system, this.messages);
    if (tokens < POST_TURN_MIN_TOKENS) return;  // 2000 tokens — too low
    await this.compactForContext(provider, system, contextWindow, signal, this.getCompactionSettings(), true).catch(() => {});
}
```

### Weakness 3 — Status bar shows accumulated only (Impact: MEDIUM)
- `in_tokens` / `out_tokens` / `session_usd` are **accumulated** (dòng 1216-1224)
- No `ctx_tokens` field showing current context size
- User can't verify compact is working from status bar alone

### Weakness 4 — Errors swallowed silently (Impact: LOW)
- `.catch(() => {})` nuốt mọi lỗi
- Tuy nhiên `_compactedThisTurn` không được set khi fail → retry ở turn sau
- OK, nhưng có thể cải thiện bằng warning log

## Solutions

### Fix 1: Show compaction savings as conversation log
**File:** `src/orchestrator/orchestrator.ts` — `compactForContext()`

After dòng 1884 (messages replaced), thêm:
```ts
const tokensAfter = estimateConversationTokens(system, this.messages);
const saved = preparation.tokensBefore - tokensAfter;
// Stats tracking
if (!this._compactionStats) this._compactionStats = { count: 0, totalSaved: 0 };
this._compactionStats.count++;
this._compactionStats.totalSaved += saved;
```

Cần thêm field `_compactionStats` trong class property và type.

### Fix 2: Smart threshold for post-turn compact
**File:** `src/orchestrator/orchestrator.ts` — `postTurnCompact()`

Thay `tokens < POST_TURN_MIN_TOKENS` bằng:
```ts
const minMeaningfulTokens = Math.max(POST_TURN_MIN_TOKENS, Math.floor(contextWindow * 0.02));
if (tokens < minMeaningfulTokens) return;
```
Lý do: 2% của context window (ví dụ 4K/200K) là threshold tối thiểu có ý nghĩa — nếu context nhỏ hơn, compact không đáng chi phí LLM call.

### Fix 3: Add `ctx_tokens` to status bar
**File:** `src/ui/status-bar/store.ts` — thêm field `ctx_tokens?: number`
**File:** `src/ui/status-bar/index.tsx` — hiển thị `[ctx: 15K]` bên cạnh accumulated tokens
**File:** `src/orchestrator/orchestrator.ts` — `recordUsage()` hoặc sau compact gọi `statusBarStore.setState({ ctx_tokens: ... })`

### Fix 4: Warning log on compaction failure
**File:** `src/orchestrator/orchestrator.ts` — thay `.catch(() => {})` bằng `.catch((err) => console.warn("[compact] failed:", err?.message))`

## Implementation Plan

### Wave 1 — Core logic changes (orchestrator.ts)
1. Thêm property `_compactionStats: { count: number; totalSaved: number }` trong class Agent
2. Sửa `compactForContext()`: tính `tokensAfter`, cập nhật stats
3. Sửa `postTurnCompact()`: smart threshold
4. Thêm status bar update sau compact

### Wave 2 — Status bar display (status-bar/ files)
5. Thêm `ctx_tokens: number` vào `StatusBarState`
6. Cập nhật `renderStatusBar()` hiển thị ctx tokens
7. Reset `ctx_tokens` khi session mới

### Wave 3 — Error logging
8. Sửa `.catch(() => {})` thành `.catch((err) => console.warn(...))` ở compact call sites

## Files Changed
| File | Change |
|------|--------|
| `src/orchestrator/orchestrator.ts` | Smart threshold, stats tracking, status bar update |
| `src/ui/status-bar/store.ts` | New `ctx_tokens` field |
| `src/ui/status-bar/index.tsx` | Display `ctx_tokens` in status bar |

## Test Plan
- Unit test: `estimateConversationTokens` đúng sau compact
- Unit test: `postTurnCompact` không gọi compact khi tokens < 2% contextWindow
- Integration: verify status bar `ctx_tokens` thay đổi sau compact
