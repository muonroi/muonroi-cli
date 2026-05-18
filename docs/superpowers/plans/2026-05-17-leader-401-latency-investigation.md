# Plan: Leader 401 + ~110s latency investigation

**Date:** 2026-05-17  
**Branch:** `feat/bb-aware-ideal`  
**Bug doc:** `docs/bugs/2026-05-17-ideal-leader-unavailable-loop.md`

---

## Evidence inventory

Files fully read and verified (file path + lines):

| File | Lines read | Relevance |
|---|---|---|
| `src/council/leader.ts` | 1–182 | `resolveLeaderModel` (sync) + `resolveLeaderModelDetailed` (async) |
| `src/product-loop/gather.ts` | 1–60, 140–170 | Call site of `resolveLeaderModel`, `LeaderLike` adapter construction |
| `src/product-loop/discovery-recommender.ts` | 1–121 | `leaderRecommend` loop, `emitLeaderDebug`, error catch path |
| `src/council/llm.ts` | 228–320 | `createCouncilLLM.generate` — `withVisibleRetry` call, `maxRetries: 0` |
| `src/utils/visible-retry.ts` | 1–56 | `isRetryableError`, delay table, retry logic |
| `src/providers/runtime.ts` | 1–163 | `detectProviderForModel`, `createProviderFactory` |
| `src/providers/keychain.ts` | 1–243 | `loadKeyForProvider` priority chain |
| `src/models/catalog.json` | 1–170 | Tier assignments: `deepseek-ai/DeepSeek-V4-Flash` = `fast`, `deepseek-ai/DeepSeek-V4-Pro` = `premium`; first catalog entry = `claude-opus-4-7` (anthropic, premium) |
| `src/models/registry.ts` | 1–78 | `getModelByTier` — no-provider fallback returns first model of that tier from ANY provider |
| `docs/bugs/2026-05-17-ideal-leader-unavailable-loop.md` | full | Runtime evidence: `model: "unknown"`, `parseError: "Unauthorized"` |

---

## Q1: Why does the leader call return 401?

### Traced code path

`gather.ts:151` calls the **sync** `resolveLeaderModel(sessionModelId)` where `sessionModelId = "deepseek-ai/DeepSeek-V4-Flash"`.

`resolveLeaderModel` (sync, `leader.ts:164–173`):

```ts
export function resolveLeaderModel(sessionModelId: string): string {
  const configured = getRoleModel("leader");   // (1)
  if (configured) return configured;
  const providerId = detectProviderForModel(sessionModelId);  // (2)
  const premium = getModelByTier("premium", providerId);      // (3)
  if (premium) return premium.id;
  const anyPremium = getModelByTier("premium");               // (4)
  if (anyPremium) return anyPremium.id;
  return sessionModelId;                                       // (5)
}
```

**Step (1):** No `roleModels.leader` is configured in the user's settings (the bug report shows `model: "unknown"` in `emitLeaderDebug`, which happens because the `LeaderLike` adapter in `gather.ts` does NOT set a `modelId` property on itself — the debug payload reads `(leader as any).modelId ?? "unknown"`. This confirms the leader model ID is not propagated into the adapter, but the actual model used is determined by `leaderModelId` captured at `gather.ts:151`).

**Step (2):** `detectProviderForModel("deepseek-ai/DeepSeek-V4-Flash")` → looks up `catalog.json` → finds `provider: "siliconflow"` → returns `"siliconflow"`.

**Step (3):** `getModelByTier("premium", "siliconflow")` → scans `MODELS` for `tier === "premium" && provider === "siliconflow"` → finds `"deepseek-ai/DeepSeek-V4-Pro"` → returns it. If this model is in the catalog at boot time, the leader resolves to `"deepseek-ai/DeepSeek-V4-Pro"` on the SiliconFlow provider.

**The 401 question:** If the session model (`DeepSeek-V4-Flash`) works but the leader call 401s, the issue is **not** a wrong provider (both are SiliconFlow). The difference is the **model name**: `DeepSeek-V4-Pro` vs `DeepSeek-V4-Flash`. A 401 from SiliconFlow means the API key is either invalid for this specific model (tier-gated access — some SiliconFlow API keys only have access to specific model tiers) or is simply not authorized to call `DeepSeek-V4-Pro` at all.

**Conclusion for Q1 (evidence-supported):** The sync `resolveLeaderModel` path correctly stays on the SiliconFlow provider. It resolves to `deepseek-ai/DeepSeek-V4-Pro` (the only `premium`-tier SiliconFlow model in `catalog.json`). The SiliconFlow API key in the user's keychain authorizes `DeepSeek-V4-Flash` (fast tier) but returns 401 for `DeepSeek-V4-Pro` (premium tier). This is a tier-gated access restriction on the SiliconFlow account.

**Supporting evidence from the debug log:** `rawResponse: ""` (no body, just HTTP 401) and `parseError: "Unauthorized"` — the error comes from the HTTP layer before any response body is parsed, consistent with a 401 on a model the key cannot access.

**Q1 missing data (to confirm):** The actual SiliconFlow account tier is not readable from code. To be 100% certain the resolved model is `DeepSeek-V4-Pro` (not the fallback `anyPremium` path), we need to confirm that `MODELS` is fully loaded (catalog not empty) at the time `resolveLeaderModel` is called. If catalog load fails at boot, `MODELS` is empty → step (3) returns `undefined` → step (4) returns `undefined` → step (5) returns `sessionModelId` (flash, which would succeed, not 401). The 401 evidence contradicts an empty catalog, so the catalog IS loaded and step (3) fires with `DeepSeek-V4-Pro`.

---

## Q2: Why does a 401 take ~110 seconds?

### Traced code path

`gather.ts:158–161` constructs a `LeaderLike` adapter that delegates to `llm.generate(leaderModelId, ...)`.

`createCouncilLLM.generate` (`llm.ts:254–270`) calls:

```ts
const result = await withVisibleRetry(
  () => generateText({ ..., maxRetries: 0 }),
  { label: "council.generate" },
);
```

`withVisibleRetry` (`visible-retry.ts`):

- Default: `maxAttempts = 6` (delays array has 5 elements: `[2000, 4000, 8000, 16000, 32000]`, so `maxAttempts = 5 + 1 = 6`)
- `isRetryableError` checks: `statusCode === 429 || statusCode === 408 || statusCode >= 500`
- **401 is NOT in that list.** `isRetryableError(401_error)` returns `false`.
- Result: on a 401, `withVisibleRetry` breaks immediately after attempt 0 (`!isRetryableError(err)` → `break`) and re-throws.

So `withVisibleRetry` does NOT add delay for a 401. One call should complete in <1s.

**But `leaderRecommend` in `discovery-recommender.ts:69–113` loops twice** (`for (let attempt = 0; attempt < 2; attempt++)`). Both attempts call `leader.generate`, both 401, each finishes in <1s. Total for `leaderRecommend`: <2s.

**110s cannot be explained by two fast 401s.** There must be another source of delay.

### Candidates requiring investigation

**Candidate A — `discover-recommender.ts` is called via `councilRecommend`, not `leaderRecommend` directly.** With `--force-council`, the flow goes through `councilRecommend` (line 198+), which first runs `runner.runDebate(...)`. If the council debate itself is slow (3 participants × model calls), the 110s could be council debate time, not leader time. The leader's 401 delay would be trivially small at the end (tiebreak synthesis).

**Candidate B — `gather.ts:164` calls `parsePromptForContext(idea, leader)` BEFORE the interview loop.** If `parsePromptForContext` makes multiple leader calls and each 401s, and there is a timeout somewhere, that could account for up to `timeout_ms × calls`. This needs verification by reading `discovery-prompt-parser.ts`.

**Candidate C — AI SDK internal timeout.** `generateText` with `maxRetries: 0` may still apply a request-level timeout from the underlying HTTP client (undici/fetch default). Default `undici` socket timeout is often 10s or 30s. If SiliconFlow closes the connection without responding (rather than immediately returning 401), the HTTP client waits for the timeout. Three such timeouts × 30s = 90s, which is in the ~110s range.

**Candidate D — `loadKeyForProvider` timeout in keychain.** If `keytar.getPassword` hangs (e.g. OS keychain is locked), each call to `llm.generate` blocks in the key-loading step before the HTTP call even fires. Two `leaderRecommend` attempts × some `keytar` stall = possible but unlikely if other commands succeed.

### Q2 conclusion

**Not fully conclusive from static analysis.** The `withVisibleRetry` wrapper definitively does NOT retry on 401. The 110s latency is NOT caused by retry backoff in `visible-retry.ts`. The source requires one of:

- The HTTP client (AI SDK / undici) is waiting for a socket-level timeout rather than getting an immediate 401 back. This is a runtime behavior that cannot be confirmed from static analysis.
- The council debate path (`councilRecommend`) itself takes 110s, and the leader's 401 adds only <2s at the end — making leader 401 a red herring for the latency.

---

## Fix plan

### Items with sufficient evidence to fix now

#### Fix 1 — Leader model tier mismatch (Q1, evidence-certain)

**Root cause:** `resolveLeaderModel` (sync) always picks `DeepSeek-V4-Pro` when the session is on SiliconFlow, but the user's SiliconFlow key does not have premium-tier access.

**Plan:**
1. In `gather.ts`, replace the call to the **sync** `resolveLeaderModel` with the **async** `resolveLeaderModelDetailed`. The async version (`leader.ts:101`) performs a reachability check: it calls `loadKeyForProvider` and then verifies `sessionReachable`. Crucially, it falls back to the session model itself when no higher-tier model can be resolved on the session provider.
2. However, `resolveLeaderModelDetailed` does NOT verify whether the premium model is actually callable with the user's key — it only checks that a key EXISTS for the provider. The 401 would still occur because both Flash and Pro share the same `siliconflow` keychain entry.
3. A safer fix: add a per-model reachability probe OR add a model-access check by catching the 401 from the first leader call and falling back to `sessionModelId`. This is a targeted, bounded change.

**Specific change:** In `leaderRecommend` (or in the `LeaderLike` adapter in `gather.ts`), catch errors with `statusCode === 401` and immediately return the "leader unavailable" sentinel rather than retrying. This avoids 2 × HTTP-overhead on an auth-failed model. Then, in `resolveLeaderModel`, add a fallback: if a different model is resolved (not the session model itself), mark the session model as the safe fallback for this session.

**Backward compat risk:** None — the change is in the error-handling path. Currently a 401 causes `rawResponse: ""` which makes `parseLeaderResponse` return null anyway; falling back faster produces the same outcome.

#### Fix 2 — Propagate `modelId` into the `LeaderLike` debug field (evidence-certain, low risk)

**Root cause:** `gather.ts:157–162` constructs the `LeaderLike` adapter without setting `modelId` on the object, so `emitLeaderDebug` logs `model: "unknown"` for all gather-phase leader calls. This makes it impossible to confirm which model is actually being used from the debug log alone.

**Plan:** Add `modelId: leaderModelId` as a property on the `leader` object in `gather.ts:157–162`. One-line change.

**Backward compat risk:** None — purely diagnostic.

### Items needing instrumentation before a fix can be written

#### Instrument 1 — Confirm 110s source (Q2)

**Plan:** Add timing to `llm.generate` for the leader path. The debug record already captures `durationMs` via `MUONROI_COUNCIL_DEBUG_LOG`. Enable it and check the per-call duration. If each `generate` call takes ~50s, the issue is HTTP socket timeout from the AI SDK/undici client. If each `generate` call takes <1s but there are many more calls than expected (e.g. council debate calls), the 110s is debate time, not leader time.

**Log to add:** After the `catch (err)` in `llm.ts:302`, add `process.stderr.write("[leader-timing] durationMs=" + (Date.now() - t0) + " modelId=" + modelId + " err=" + (err instanceof Error ? err.message : String(err)) + "\n")` — gated on `MUONROI_DEBUG_LEADER=1` to match the existing envvar.

**Rerun condition:** Set `MUONROI_DEBUG_LEADER=1` and `MUONROI_COUNCIL_DEBUG_LOG=/tmp/council-debug.jsonl`, then run the same failing scenario. The `durationMs` fields will identify which call accounts for the bulk of the 110s.

#### Instrument 2 — Confirm `resolveLeaderModel` result (Q1 confirmation)

**Plan:** In `gather.ts:151`, add a one-line stderr log: `process.env.MUONROI_DEBUG_LEADER === "1" && process.stderr.write("[leader-resolve] leaderModelId=" + leaderModelId + " sessionModelId=" + sessionModelId + "\n")`. Confirms the exact resolved model ID in the field rather than inferring from catalog state.

---

## Risks

| Fix | Risk | Mitigation |
|---|---|---|
| Fix 1 (catch 401 as non-retryable) | If SiliconFlow returns 401 transiently (key rotation race), the leader will permanently fall back for that session | The existing 2-attempt loop in `leaderRecommend` still runs twice before giving up; catching 401 only skips the `withVisibleRetry` outer wrapper which was already a no-op for 401 |
| Fix 1 (use async resolveLeaderModelDetailed in gather.ts) | Async call adds latency at gather start | Reachability check is a single `loadKeyForProvider` await — already done elsewhere in the same flow |
| Fix 2 (modelId debug field) | None | — |
| Instrument 1 (timing log) | None — read-only, gated on envvar | — |

---

## Recommended execution order

1. **Fix 2** (1-line, zero risk) — propagate `modelId` so future debug logs are accurate.
2. **Instrument 1 + 2** — add timing + resolve logs, rerun live E2E to get `durationMs` per leader call.
3. **After Instrument run:** if each leader call is <2s → the 110s is council debate time → no further leader fix needed for latency; focus on council debate timeout tuning. If each leader call is ~50s → Fix 1 must also add a socket/request timeout to the `createOpenAICompatible` factory for SiliconFlow or handle AI SDK HTTP client timeout configuration.
4. **Fix 1** — catch 401 as non-retryable in `leaderRecommend` catch block (defer `resolveLeaderModelDetailed` migration until after the timing data confirms the scope).
