# Plan: Layer B skip-budget counter reset fix

**Date:** 2026-05-17  
**Branch:** feat/bb-aware-ideal  
**Scope:** `src/product-loop/discovery-interview.ts` + test

---

## Root Cause

**File:** `src/product-loop/discovery-interview.ts`, lines 88–129.

`skipAttempts` is declared with `let skipAttempts = 0` **inside** the outer `for (const question of DISCOVERY_QUESTIONS)` loop body (line 88), but **outside** the inner `for (;;)` loop.

The reset bug is at **line 129**:
```ts
// User provided a real answer — reset the skip counter.
skipAttempts = 0;
```

This line fires whenever `ans.action !== "skip"` — including `"override"`. The intent was to reset on a *successful, validated* answer, but the reset happens **before** validation (line 145–152). So the sequence is:

1. `ans.action === "override"` → line 129: `skipAttempts = 0`  ← RESET HERE
2. `validateAnswer(question.id, chosenValue)` → `!validation.ok`
3. `await opts.userPrompt(...)` (invalid message)
4. `continue` → loops back with counter at 0

The counter never accumulates cross-attempt budget because every override attempt (valid or not) zeroes it. This allows infinite `skip → override(invalid) → skip → override(invalid)` alternation, with `skipAttempts` oscillating between 0 and 1 forever.

**Is it intentional?** No. The comment says "User provided a *real* answer" — but an invalid override is not a real answer. The reset should only happen when the inner loop actually `break`s with a saved answer (i.e., after `saveDiscoveryAnswer`).

**Are other actions affected?**
- `accept` → also hits line 129, resets. Same problem if `validateAnswer` fails for accept (less likely in practice since recommend values should validate).
- `abort` → throws immediately, no issue.
- `more-options` → `continue` without reaching line 129, no issue.

**Is there an `invalidAttempts` counter?** No, there is only `skipAttempts`. There is no separate budget for invalid overrides.

---

## Options

### Option A — Move the reset to post-`break` only (minimal diff)

Remove line 129 (`skipAttempts = 0`) entirely. The counter only resets naturally when the outer `for` advances to the next question (because `let skipAttempts = 0` re-executes per question). An override-then-invalid path no longer erases accumulated skip debt.

- **Pro:** 2-line change, zero new state, existing tests still pass.
- **Con:** A user who skips twice, then provides a *valid* override, still carries `skipAttempts = 2` into any subsequent re-entry. But that can't happen — a valid override triggers `break` immediately and the outer loop moves on. So the reset is actually **unnecessary** in all cases. Removing it is safe.

### Option B — Add a separate `invalidOverrideAttempts` counter, escalate on either threshold

Add `let invalidOverrideAttempts = 0; const MAX_INVALID = 3;`. Increment after every `!validation.ok` path. Escalate (break) when either `skipAttempts >= MAX_SKIP_ATTEMPTS` OR `invalidOverrideAttempts >= MAX_INVALID`.

- **Pro:** Two independent budgets — user can't exhaust skip budget via override failures.
- **Con:** More state, two independent thresholds to tune, doubles the escalation surface. Overkill for the current pattern.

### Option C — Total-attempts counter (skip + invalid-override + any retry)

Single `totalRejections` counter, incremented on skip-rejected AND invalid-answer. Escalate when `totalRejections >= MAX_TOTAL` (e.g. 5).

- **Pro:** Single number, covers all abuse vectors.
- **Con:** Penalizes the user for honest override mistakes as harshly as deliberate skips. Different UX intent.

---

## Recommended Approach: **Option A**

Delete line 129. Rationale:
- The reset was written under the assumption that "override = real answer", which is only true post-validation.
- Post-`break`, the outer loop re-declares `skipAttempts = 0` anyway, so the reset is redundant for the success path.
- Zero new state. The existing `MAX_SKIP_ATTEMPTS = 3` budget then counts across *all* non-answer iterations (skip + invalid-override), which is the most conservative and simplest semantic.
- The existing unit tests still describe the correct behavior — `productTypeAttempts` counts prompts, not the counter value.

---

## Task Breakdown

### Task 1 — Remove the counter reset (discovery-interview.ts)

**File:** `src/product-loop/discovery-interview.ts`  
**Location:** Line 129

Delete this block:
```ts
// User provided a real answer — reset the skip counter.
skipAttempts = 0;
```

No other changes to production code. The surrounding logic handles the path correctly once the spurious reset is gone.

**Diff sketch:**
```diff
-      // User provided a real answer — reset the skip counter.
-      skipAttempts = 0;
-
       let chosenValue: any;
```

---

### Task 2 — Add regression unit test (discovery-interview.test.ts)

**File:** `src/product-loop/__tests__/discovery-interview.test.ts`  
**Location:** Inside `describe("skip-budget: required question escalation")` block, after the existing two tests.

Test name: `"override(invalid) does not reset skip budget — skip×2 → override(invalid) → skip escalates"`

```ts
it("override(invalid) does not reset skip budget — skip×2 → override(invalid) → skip escalates", async () => {
  const validAnswers = {
    targetPlatform: ["cli"],
    audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
    backendArchitecture: "monolith",
    backendStack: { language: "TS", framework: "Nest" },
    dbStrategy: { mode: "greenfield", engine: "PG" },
  };
  const rec = {
    leaderRecommend: vi.fn(async ({ question }: any) => ({
      primary: {
        value: question.id === "productType" ? null : validAnswers[question.id as keyof typeof validAnswers],
        rationale: question.id === "productType" ? "unavailable" : "r",
      },
      alternatives: [],
      source: "leader" as const,
      costUsd: 0,
    })),
    councilRecommend: vi.fn(async ({ question }: any) => ({
      primary: { value: validAnswers[question.id as keyof typeof validAnswers], rationale: "r" },
      alternatives: [],
      source: "council" as const,
      costUsd: 0.3,
    })),
  };

  const OPTIONAL_IDS = new Set(["frontendApproach", "baStatus", "designStatus", "deployment"]);
  let productTypePromptCount = 0;
  const userPrompt: UserPromptFn = async ({ questionId, message }) => {
    if (message) return { action: "more-options" };
    if (questionId === "productType") {
      productTypePromptCount += 1;
      if (productTypePromptCount === 1) return { action: "skip" };        // skip #1 (counts as skip 1)
      if (productTypePromptCount === 2) return { action: "skip" };        // skip #2 (counts as skip 2)
      if (productTypePromptCount === 3) {
        // override with invalid value — should NOT reset counter
        return { action: "override", value: "NOT_A_VALID_PRODUCT_TYPE", reason: "test" };
      }
      // skip #3 after invalid override — should exhaust budget
      return { action: "skip" };
    }
    if (questionId === "__user_gate__") return { action: "proceed" };
    if (OPTIONAL_IDS.has(questionId)) return { action: "skip" };
    return { action: "accept" };
  };

  await iterateInterview({
    flowDir,
    runId,
    idea: "x",
    capUsd: 50,
    detection: FAKE_DETECTION,
    userPrompt,
    recommender: rec as any,
  });

  // productType should NOT be answered (escalated as unspecified)
  const state = await readDiscoveryState(flowDir, runId);
  expect(state?.questionsAnswered).not.toContain("productType");
  // The loop must have exited — not infinite
  // promptCount: 2 skips + 1 invalid-override + 0 more skips = loop exits on 3rd skip attempt
  // With the bug: promptCount would be 4+ (counter reset allows more skips)
  expect(productTypePromptCount).toBeLessThanOrEqual(4);
});
```

> Note: with Option A fix applied, the test passes because the 2 skips + 1 invalid-override exhaust the budget (each `continue` in the invalid-override path does NOT increment `skipAttempts` directly, but the previous 2 skips already brought it to 2; the next `skip` after the invalid-override brings it to 3 → escalates). Prompt count = 4 total (skip1, skip2, invalid-override, skip3 that triggers escalation). Without the fix, promptCount would loop infinitely.

---

## Cross-Reference: Spec navigation race

The live E2E spec alternates `skip → override(invalid)` because the auto-responder sends `override` when it meant to send `skip` (a distinct race/confusion in the spec responder). **Even if the spec was corrected to always send skip**, the Layer B counter-reset bug would still not manifest in the pure-skip path — `skipAttempts` increments correctly for consecutive skips. The counter-reset bug **only manifests** when an override(invalid) is interspersed between skips. So fixing the spec responder is a separate concern and does not eliminate this bug.

---

## Verification

1. `bunx vitest run src/product-loop/__tests__/discovery-interview.test.ts` — all tests pass (including new regression test).
2. `bunx tsc --noEmit` — 0 errors (no type changes involved).
3. Live E2E: `skip → override(invalid) → skip → skip` sequence should escalate after 3rd real skip, not loop.

---

## Risk & Estimate

| Item | Detail |
|------|--------|
| Risk | Low — removing a spurious reset; the success path is unaffected (valid answer always `break`s before counter matters next time) |
| Regression surface | Only `discovery-interview.ts` inner loop |
| Estimate | 15 min (1 line delete + 1 test) |
| Related | CB-3 downstream already handles unspecified required dimensions; no CB change needed |
