# `/ideal` infinite askcard loop when leader unavailable

**Discovered:** 2026-05-17 during live E2E verification of harness event-stream upgrade.
**Severity:** P1 — blocks `/ideal --force-council` on any prompt where the leader LLM cannot parse a valid recommendation.
**Repro reliability:** 100% with `/ideal --force-council build fraud detection service` against `siliconflow/deepseek-ai/DeepSeek-V4-Flash`.

## Symptom

Same `productType` askcard re-emits indefinitely. Each render:

```
askcard(dialog)[modal]
  name="Question: productType\nRecommended: null — leader unavailable; awaiting user"
  askcard-option-override[sel] name="override"
  askcard-option-skip          name="skip"
  askcard-option-abort         name="abort"
```

User picks `skip` → council re-emits the same productType question. Picking any of the 3 options never advances the flow.

## Root cause (traced)

```
src/product-loop/discovery-recommender.ts:51-71
  leader.generate → parseLeaderResponse fails twice
  → returns { primary: { value: null, rationale: "leader unavailable; awaiting user" } }

src/product-loop/gather.ts:99-110
  hasRecommendation = false (primary.value is null)
  → emit askcard with options = ["override", "skip", "abort"]
  // No 'accept' option, so the only "move on" path is override (freetext JSON)
  // or skip (rejected for required dims) or abort (cancels the run)

src/product-loop/discovery-interview.ts:92-95
  if (ans.action === "skip") {
    if (effectivelyRequired) {
      userPrompt({ ..., message: "Required question cannot be skipped" });
      continue;   // ← LOOP. No max-retry guard.
    }
  }
```

`productType` is a required dimension. `skip` is rejected. The loop re-emits the same askcard with no retry budget.

## Two layered bugs

### Layer A — Leader returns null

`parseLeaderResponse` fails twice in `discovery-recommender.ts:54`. Common causes (per the existing comment in that file):

- Reasoner models (`deepseek-v4-pro`, `o3`) consume the output budget for reasoning tokens, leaving the JSON tail truncated.
- Model returns JSON wrapped in markdown fences that the parser doesn't strip.
- Model deviates from the schema entirely.

`maxTokens: 4096` was raised from 1024 to mitigate the reasoner truncation case, but failures still occur on `DeepSeek-V4-Flash` for the test prompt.

**Diagnostic gap:** raw leader response is not logged. Adding a `MUONROI_DEBUG_LEADER=1` envvar that dumps the raw response on parse failure would let us identify which of the three cases is hitting.

### Layer B — No retry budget

Even if Layer A is unfixable in some cases (some models will always emit invalid JSON for some prompts), the gather phase should not loop forever on a required dimension. Possible guards:

1. **Counter:** track per-question askcard re-emit count. After N=3 rejected skips, treat as `unspecified` and proceed (downstream may still halt at CB-3 with "verify recipe missing" — a CLEAN halt that the test asserts).
2. **Force-default:** after N retries, force a sensible default for known dimensions (e.g. `productType="cli"` for greenfield) and continue.
3. **Promote to halt:** emit `sprint-halt` with reason `gather-stuck` instead of looping, so the user gets the halt-card with options.

Option 3 aligns best with existing CB-3 halt semantics. Option 1 is the smallest change.

## Diagnostic evidence

`.scratch/e2e-diag.log` from run `bb0s5nzqw` shows 5 consecutive identical askcards with PICKED="skip", followed by the spec timing out at 450s. No `sprint-halt` event fires.

## 2026-05-17 follow-up — Layer A + B landed, NEW bug surfaced

After fixes commits `eafc8e5` (Layer B retry budget) + `47cb460` (Layer A debug
logging) + spec race fix (Down→wait_for(idle)→Enter):

- Leader debug confirms `parseError: "Unauthorized"`, `rawResponse: ""`,
  `model: "unknown"` → leader HTTP call is 401-ing, NOT a parser bug. The
  `resolveLeaderModel(sessionModelId)` result is `"unknown"` — keychain →
  model registry mismatch needs separate audit.
- Layer B verified working end-to-end: 3× productType skip → outer loop
  advanced to `targetPlatform` (q4 has different question name in dump).
- New blocker: each askcard cycle takes ~110s real-time even though leader
  returns immediately with 401. Likely an HTTP retry/backoff inside the
  provider wrapper before the 401 surfaces as parse_fail. Profile / instrument
  the leader.generate call timing to confirm.

## Open

- WHY does `resolveLeaderModel` return a model that 401s when the session
  model itself works fine? Probably `getRoleModel("leader")` config or
  provider key resolution mismatch.
- WHERE is the ~100s/call delay coming from given a 401 response should be
  instant? Suspect provider HTTP-client retry config (e.g. exponential backoff
  on transient errors that incorrectly treats 401 as transient).

## Recommended fix order

1. Land Layer B option 1 (max-retry counter) — bounded scope, restores test progress, fail-soft on any future Layer A regression.
2. Add `MUONROI_DEBUG_LEADER=1` raw-response logging.
3. With Layer B in place + Layer A diagnostics, run live again and see if a different prompt or model avoids the parse failure.

## Out of scope for this report

- Council leader prompt template tuning
- Switching the leader model in `resolveLeaderModel`
- Retry budget on `parseLeaderResponse` itself (currently 2, may need 3 with backoff)
