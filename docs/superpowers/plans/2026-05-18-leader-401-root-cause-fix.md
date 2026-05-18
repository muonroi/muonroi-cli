# Plan: Leader 401 Root Cause Fix

**Date:** 2026-05-18  
**Branch:** `feat/bb-aware-ideal`  
**Status:** Draft — awaiting approval before code change

---

## 1. Root Cause (Confirmed with Line Numbers)

### Call chain

```
runGatherPhase()                    gather.ts:172
  → resolveLeaderModelDetailed(sessionModelId)   leader.ts:101
  → leaderModelId returned
  → leader.generate(leaderModelId, ...)          gather.ts:194
    → llm.generate(leaderModelId, ...)           council/llm.ts:235
      → detectProviderForModel(modelId)          runtime.ts:149
      → loadKeyForProvider(providerId)           keychain.ts:125
      → generateText(...)
```

### The upgrade logic

`resolveLeaderModelDetailed` (leader.ts:101–161) scans all models on the session
provider and picks the **highest-tier** one. When the session model is
`siliconflow/deepseek-ai/DeepSeek-V4-Flash` (provider=`siliconflow`, tier=`fast`),
the catalog has:

| id | provider | tier |
|----|----------|------|
| `deepseek-ai/DeepSeek-V4-Flash` | siliconflow | fast |
| `deepseek-ai/DeepSeek-V4-Pro`   | siliconflow | **premium** |

Because `TIER_RANK[premium]=3 > TIER_RANK[fast]=1`, the loop always picks
`deepseek-ai/DeepSeek-V4-Pro` as `best` and returns it (leader.ts:159).

### Why this causes 401

`llm.generate` at council/llm.ts:248 calls:

```ts
const providerId = detectProviderForModel(modelId);   // "siliconflow"
const key = await loadKeyForProvider(providerId);      // siliconflow key ✓
const { factory } = createProviderFactory(providerId, { apiKey: key });
const runtime = resolveModelRuntime(factory, modelId); // modelId = "deepseek-ai/DeepSeek-V4-Pro"
```

The key **is** loaded correctly for `siliconflow` — the provider resolution is
not broken. The 401 comes from the **SiliconFlow API itself** rejecting
`deepseek-ai/DeepSeek-V4-Pro`. The user's SiliconFlow account / key does NOT
have access to the Pro model (access-controlled or billing tier), but DOES have
access to Flash. The gather phase chunks (which use the session model = Flash)
succeed, confirming the key is valid for Flash but not Pro.

**Summary:**
- `resolveLeaderModelDetailed` auto-promotes Flash → Pro on siliconflow (by design, leader.ts:134)
- User key has no Pro access → SiliconFlow returns 401 on every Pro call
- `isUnauthorizedError` detects 401 and breaks the retry loop early (discovery-recommender.ts:144)
- `leaderRecommend` returns `{ value: null, source: "user-only" }` (discovery-recommender.ts:148–153)
- Every askcard hides the "accept" option (gather.ts:123) → user must override/skip/abort all questions
- This cascades into skip-budget exhaustion → 450s flow vs expected < 100s

---

## 2. Options

### Option A — Use session model for leader (no tier-upgrade) ★ RECOMMENDED

**Change:** In `resolveLeaderModelDetailed` (leader.ts:101), when the reachability
check for the session provider passes and no configured `roleModels.leader` exists,
return `{ modelId: sessionModelId, defaulted: true }` instead of scanning for the
highest-tier model.

Alternatively (simpler): add a reachability check for the promoted model before
returning it. If `loadKeyForProvider` is not the issue (it's the same provider),
add a **model-level** probe or simply cap leader at the session model's tier when
no explicit `roleModels.leader` is configured.

The simplest targeted fix: **when `defaulted=true` (no configured leader), return
the session model itself**, not the highest-tier model from the provider catalog.
The tier-upgrade logic only makes sense when the user has explicitly opted into
a role-model config — without it, we should not silently cross billing tiers.

**Risk:** Flash may produce less reliable JSON for leader recommendations.
Mitigation: Flash is already used successfully for all gather-phase chunks; the
leader system prompt is simple JSON-output with schema hint. Flash handles this
fine in practice. If a parse failure occurs, the existing retry (2 attempts)
handles it without the 401 hard-stop.

**Diff sketch:**

```diff
// leader.ts:157-160
-  // No usable configured leader — pick best from session provider.
-  if (best) return { modelId: best.id, defaulted: true };
-  return { modelId: sessionModelId, defaulted: true };
+  // No configured leader — stay on session model (avoid silent tier-upgrade
+  // that may 401 if user's key doesn't have access to the premium tier).
+  return { modelId: sessionModelId, defaulted: true };
```

Two lines deleted, one line changed. Zero new dependencies.

---

### Option B — Fix model ID provider prefix (add `siliconflow/` wrapper)

**Not applicable.** The model ID `deepseek-ai/DeepSeek-V4-Pro` is the correct
canonical SiliconFlow ID (per catalog.json:151). The provider detection returns
`siliconflow` correctly. The key is loaded. The 401 is from the SiliconFlow
API rejecting the user's key for the Pro model — a billing/access issue, not a
model ID mismatch.

---

### Option C — Fallback chain: try Pro → 401 → retry with Flash

**Change:** In `leaderRecommend` / `councilRecommend`, catch 401 and retry with
a fallback model (the session model). Requires passing `sessionModelId` into
`leaderRecommend` and building a second `LeaderLike` adapter.

**Pro:** Preserves the tier-upgrade aspiration.  
**Con:** More complex, adds latency (one wasted Pro call per question), and the
262ms wasted call per question × 12 questions = ~3s overhead. The real issue is
that users with Flash-only access should never attempt Pro.

---

## 3. Recommended Approach

**Option A.** Remove the implicit tier-upgrade when no `roleModels.leader` is
configured. The intent of auto-promotion is to give users a better leader when
they have premium access — but without an explicit opt-in, it silently crosses
billing tiers and causes 401 on most SiliconFlow free/student accounts.

If users want Pro for leader, they should set `roleModels.leader = deepseek-v4-pro-sf`
explicitly. The UI for this exists (`src/cli/config/screen-council.ts`).

---

## 4. Task Breakdown

| # | File | Line | Change |
|---|------|------|--------|
| T1 | `src/council/leader.ts` | 157–160 | Remove `best.id` branch for `defaulted` path; always return `sessionModelId` when no configured leader exists |
| T2 | `src/council/leader.ts` | 101 (doc comment) | Update JSDoc: remove "quality-aware promotion" language from the defaulted case |
| T3 | `src/council/__tests__/` | new test | Unit test: `resolveLeaderModelDetailed("deepseek-ai/DeepSeek-V4-Flash")` with Pro in catalog → returns Flash, not Pro, `defaulted: true` |
| T4 | `src/council/__tests__/` | existing | Verify existing test for configured-leader promotion still passes (Option A only affects `defaulted` branch) |

---

## 5. Verification

### Unit test (T3)
```ts
// Given: MODELS includes both siliconflow/Flash (fast) and siliconflow/Pro (premium)
// Given: no roleModels.leader configured
// Given: loadKeyForProvider("siliconflow") resolves
const result = await resolveLeaderModelDetailed("deepseek-ai/DeepSeek-V4-Flash");
expect(result.modelId).toBe("deepseek-ai/DeepSeek-V4-Flash");
expect(result.defaulted).toBe(true);
expect(result.promotedFrom).toBeUndefined();
```

### Live E2E re-run
Expected log after fix:
```
[leader-resolve] leaderModelId=deepseek-ai/DeepSeek-V4-Flash sessionModelId=siliconflow/deepseek-ai/DeepSeek-V4-Flash defaulted=true
[leader-timing] {"durationMs":~800,"outcome":"ok","modelId":"deepseek-ai/DeepSeek-V4-Flash"}
```
- No `[leader-timing] outcome=throw` lines
- Askcard shows `["accept","override","more-options","skip","abort"]` (5 options, not 3)
- User can press Enter to accept recommendation → no skip-budget consumption
- Total flow time < 100s (vs current 450s timeout)

---

## 6. Cross-Reference: How Other Fixes Help

After Leader 401 fix:
- **Drain stall fix** (2026-05-17): the gather loop drain no longer stalls on
  `respondToQuestion` blocking because users can `accept` instead of forced
  `override/skip`. Fewer question round-trips → faster drain loop termination.
- **Layer B counter fix** (2026-05-17): skip count stays at 0 rather than
  accumulating to the soft limit. `shouldContinue` stays `true` throughout all
  seed questions. No premature `reason: skip-limit` halt.
- Combined effect: full 12-question gather phase completes in 1 pass with
  auto-accepted recommendations, flow continues to research → spec → sprint
  without user-forced overrides.

---

## 7. Risk

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Flash produces malformed JSON (non-null parse failure) | Low | 2-attempt retry in `leaderRecommend`; existing code already handles |
| Flash leader gives lower quality recommendations | Low | Gather phase JSON is simple (string/enum choices); Flash handles this class of output reliably |
| Users with Pro access lose the auto-upgrade | Medium | They can set `roleModels.leader` explicitly; log a note when `defaulted=true` so users know they can configure |
| Breaks configured-leader promotion path | None | Option A only changes the `!configured` branch; configured leaders are unaffected |

---

## 8. Estimate

| Task | Time |
|------|------|
| T1 — code change (2 lines) | 5 min |
| T2 — JSDoc update | 5 min |
| T3 — unit test | 20 min |
| T4 — verify existing tests | 10 min |
| E2E re-run + confirm log | 15 min |
| **Total** | **~55 min** |
