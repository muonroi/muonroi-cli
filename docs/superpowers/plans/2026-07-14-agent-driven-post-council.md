# Agent-Driven Post-Council Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the CLI-hardcoded post-debate option card from auto-council and `/council` so the follow-up ("what to do next") comes from the main agent's own intent (respond / `ask_user` / implement), not a fixed CLI menu.

**Architecture:** Both auto-council and `/council` already flow through `orchestrator.runCouncilV2` → `runCouncil`. Passing `convenePath: true` suppresses the entire post-debate block (card + option-set + preflight prompt + escalation) — behavior already implemented and tested for `convene_council`. We then replace the `chosenAction`-driven `postDebateContinuation(...)` re-entry prompt with a single **neutral** continuation that hands the synthesis to a normal agent turn plus a non-binding nudge. `convene_council` keeps its native splice-resume (it is a live tool call). `/ideal` is untouched.

**Tech Stack:** TypeScript, AI SDK v6 (`ai`), Bun, Vitest, OpenTUI React, agent-harness (MCP + named-pipe transport).

## Global Constraints

- **Zero Hardcode Rule:** no literal model/provider IDs — council models resolve via `pickCouncilTaskModel` / catalog (unaffected here; do not introduce any).
- **No Silent Catch Rule:** every `try/catch` logs module + operation + `err.message`.
- **Scope lock:** change ONLY auto-council (`tool-engine.ts`) and `/council` slash (`use-app-logic.tsx` + `orchestrator.runCouncilV2` continuation). Do NOT touch `/ideal` (`runProductLoopV1`, `sprint-runner.ts`) or `convene_council` (`tool-engine.ts:3509` consumption).
- **Pre-Push Test Gate:** `bunx tsc --noEmit` (0 errors) + `bunx vitest run` (0 failures) before any push. UI/harness surfaces additionally need harness E2E.
- **Language:** code, comments, commit messages in English.
- `postDebateContinuation` (`src/council/index.ts:280`) STAYS in place (its comment claims `/ideal` build-flow reliance; grep shows only these two callers today, but keep it + its test rather than delete — the two redesigned sites simply stop calling it).

---

### Task 1: Neutral post-council continuation builder

Add a pure function that turns a council synthesis into a single neutral re-entry prompt — no `chosenAction`, no option enumeration, non-binding.

**Files:**
- Modify: `src/council/index.ts` (add export next to `postDebateContinuation`, ~line 323)
- Test: `src/council/__tests__/neutral-post-council-continuation.test.ts`

**Interfaces:**
- Consumes: nothing (pure string→string).
- Produces: `export function buildNeutralPostCouncilContinuation(synthesis: string): string` — returns a prompt embedding the synthesis + a non-binding capability nudge. Returns `""` for empty/whitespace synthesis (caller treats `""` as "no continuation").

- [ ] **Step 1: Write the failing test**

Create `src/council/__tests__/neutral-post-council-continuation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildNeutralPostCouncilContinuation } from "../index.js";

describe("buildNeutralPostCouncilContinuation", () => {
  const SYNTH = '```json\n{"type":"analysis","conclusion":"Use approach 2"}\n```';

  it("embeds the synthesis verbatim", () => {
    expect(buildNeutralPostCouncilContinuation(SYNTH)).toContain(SYNTH);
  });

  it("hands the decision to the agent without enumerating a fixed CLI option set", () => {
    const p = buildNeutralPostCouncilContinuation(SYNTH);
    // Non-binding: names the agent's OWN capabilities, not a menu the CLI adjudicates.
    expect(p).toMatch(/ask_user/);
    expect(p).toMatch(/respond|deliverable/i);
    expect(p).toMatch(/implement/i);
    // Must NOT re-introduce the hardcoded action tokens the card used.
    expect(p).not.toMatch(/continue_session|generate_plan|save_exit/);
  });

  it("returns empty string for a blank synthesis (no continuation)", () => {
    expect(buildNeutralPostCouncilContinuation("")).toBe("");
    expect(buildNeutralPostCouncilContinuation("   \n ")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/neutral-post-council-continuation.test.ts`
Expected: FAIL — `buildNeutralPostCouncilContinuation is not a function` (not exported yet).

- [ ] **Step 3: Add the implementation**

In `src/council/index.ts`, immediately AFTER the closing `}` of `postDebateContinuation` (currently ends at line 323), add:

```ts
/**
 * Neutral post-council continuation. Used by the auto-council path (tool-engine)
 * and the `/council` slash path (runCouncilV2) once they run with
 * `convenePath: true` — the hardcoded post-debate option card is suppressed, so
 * there is no `chosenAction` to branch on. Instead of the CLI deciding the next
 * step, we hand the synthesis back to a normal agent turn with a NON-BINDING
 * nudge and let the agent's own intent drive the follow-up (respond / ask_user /
 * implement). Returns "" for an empty synthesis so the caller skips re-entry.
 */
export function buildNeutralPostCouncilContinuation(synthesis: string): string {
  if (!synthesis || !synthesis.trim()) return "";
  return (
    `Council debate completed. Conclusion:\n\n${synthesis}\n\n` +
    `You now decide the next step based on the user's original request — do not ` +
    `stop without doing one of these:\n` +
    `  • If the conclusion IS the deliverable (analysis/evaluation/decision), ` +
    `respond to the user with it.\n` +
    `  • If a choice genuinely needs the human before proceeding, call ask_user.\n` +
    `  • If the task calls for building and the conclusion is a sufficient spec, ` +
    `implement it now through your normal workflow — do NOT re-litigate the ` +
    `decision or expand scope beyond it.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/neutral-post-council-continuation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/council/index.ts src/council/__tests__/neutral-post-council-continuation.test.ts
git commit -m "feat(council): neutral post-council continuation builder"
```

---

### Task 2: Wire auto-council onto convenePath + neutral continuation

Auto-council currently runs `runCouncilV2` without `convenePath` (so the hardcoded card fires) and routes the follow-up via `postDebateContinuation(chosenAction, synthesis)`. Add `convenePath: true` and swap to the neutral builder.

**Files:**
- Modify: `src/orchestrator/tool-engine.ts:813-833`
- Test: `src/orchestrator/__tests__/message-processor.test.ts` (extend the existing auto-council delegation test at ~line 166)

**Interfaces:**
- Consumes: `buildNeutralPostCouncilContinuation` (Task 1).
- Produces: no new exports; changes runtime behavior of the auto-council branch in `processMessageTurn`.

- [ ] **Step 1: Write the failing test**

Open `src/orchestrator/__tests__/message-processor.test.ts`. The existing test "delegates to deps.runCouncilV2 when auto-council gate is taken" (~line 166) builds `deps` with a `runCouncilV2` async-generator stub. Add a NEW test after it that captures the options `runCouncilV2` is called with. Model it on the existing one but record the second arg:

```ts
it("auto-council runs runCouncilV2 with convenePath:true (no hardcoded post-debate card)", async () => {
  let capturedOpts: Record<string, unknown> | undefined;
  const deps = makeAutoCouncilDeps({
    // reuse whatever helper the neighbouring test uses to build deps;
    // if it inlines deps, copy that object and override runCouncilV2:
    runCouncilV2: async function* (_msg: string, opts?: Record<string, unknown>) {
      capturedOpts = opts;
      yield { type: "content", content: "debate" } as never;
    },
  });
  // Drive the same entry the neighbouring test drives (processMessageTurn / the
  // exported turn fn) so shouldAutoCouncil is taken, then:
  expect(capturedOpts?.convenePath).toBe(true);
});
```

> NOTE for implementer: match the EXACT deps-construction and invocation style
> of the adjacent passing test (line ~166). If that test constructs `deps`
> inline and calls a specific exported function, replicate that call verbatim
> and only add the `capturedOpts` capture. Do not invent a `makeAutoCouncilDeps`
> helper if one does not already exist — inline the object instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/orchestrator/__tests__/message-processor.test.ts -t "convenePath"`
Expected: FAIL — `capturedOpts.convenePath` is `undefined` (auto-council doesn't pass it yet).

- [ ] **Step 3: Add `convenePath: true` to the auto-council call**

In `src/orchestrator/tool-engine.ts`, change the auto-council `runCouncilV2` call (currently lines 813-817):

```ts
    yield* deps.runCouncilV2(userMessage, {
      skipClarification: !isAutoCouncilClarifyEnabled(),
      observer,
      userModelMessage,
    });
```

to:

```ts
    yield* deps.runCouncilV2(userMessage, {
      skipClarification: !isAutoCouncilClarifyEnabled(),
      observer,
      userModelMessage,
      // Suppress the CLI-hardcoded post-debate option card. The follow-up is
      // decided by the agent's own intent via the neutral continuation below,
      // not a fixed CLI menu. (Pre-debate clarification is orthogonal and still
      // runs per skipClarification.)
      convenePath: true,
    });
```

- [ ] **Step 4: Swap the continuation to the neutral builder**

Still in `src/orchestrator/tool-engine.ts`, replace the post-council continuation block (currently lines 822-828):

```ts
    // Honor the user's post-debate choice instead of always continuing: an
    // evaluation/decision debate whose deliverable is the conclusion (default
    // save_exit) now returns to the composer rather than being force-fed a
    // meaningless "proceed with the action items" turn. postDebateContinuation
    // is shared with the /council slash path (orchestrator.runCouncilV2).
    const { postDebateContinuation } = await import("../council/index.js");
    const continuationPrompt = synthesis ? postDebateContinuation(chosenAction ?? undefined, synthesis) : null;
```

with:

```ts
    // convenePath suppressed the hardcoded card, so there is no chosenAction to
    // branch on. Hand the synthesis to a normal agent turn with a non-binding
    // nudge and let the agent decide the next step (respond / ask_user /
    // implement). Re-entry is guarded by setContinuation(true) below so
    // shouldAutoCouncil (which checks !isContinuation) can't re-fire into a loop.
    const { buildNeutralPostCouncilContinuation } = await import("../council/index.js");
    const continuationPrompt = synthesis ? buildNeutralPostCouncilContinuation(synthesis) || null : null;
```

> `chosenAction` (read at line 819 from `lastPostDebateAction`) is now always
> `null` (card suppressed) — leave the two `deps.councilManager` reads/resets at
> 818-821 as-is; they are harmless and keep the manager state clean.

- [ ] **Step 5: Run typecheck + the targeted test**

Run: `bunx tsc --noEmit`
Expected: 0 errors.
Run: `bunx vitest run src/orchestrator/__tests__/message-processor.test.ts`
Expected: PASS (existing tests + the new convenePath test).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/tool-engine.ts src/orchestrator/__tests__/message-processor.test.ts
git commit -m "feat(council): auto-council uses convenePath + neutral continuation"
```

---

### Task 3: Wire /council slash onto convenePath + neutral continuation

The `/council` slash path dispatches `agent.runCouncilV2(topic)` (no options) from the UI, and `runCouncilV2` routes its continuation via `postDebateContinuation`. Pass `convenePath: true` at the dispatch site and swap the continuation builder.

**Files:**
- Modify: `src/ui/use-app-logic.tsx:4640` (NUL byte in file — edit with the Edit tool via unique surrounding string; verify with `rg -a`)
- Modify: `src/orchestrator/orchestrator.ts:2063` (import) and `:2185` (continuation)
- Test: `src/council/__tests__/convene-path.test.ts` (extend — assert the slash-style run with `convenePath:true` emits no post-debate card)

**Interfaces:**
- Consumes: `buildNeutralPostCouncilContinuation` (Task 1); the `convenePath` option already accepted by `runCouncilV2` (`orchestrator.ts:2060`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

`src/council/__tests__/convene-path.test.ts` already asserts `convenePath:true` suppresses the post-debate card at the `runCouncil` layer. Add a test that the `/council` continuation uses the neutral builder (not `postDebateContinuation`). Since the continuation lives in `orchestrator.runCouncilV2`, assert at the unit level that with an undefined `chosenAction` (card suppressed) the neutral builder is what produces a non-null prompt:

```ts
import { buildNeutralPostCouncilContinuation, postDebateContinuation } from "../index.js";

describe("/council convenePath continuation source", () => {
  const SYNTH = '```json\n{"type":"analysis","conclusion":"x"}\n```';
  it("neutral builder returns a prompt where postDebateContinuation(undefined) returns null", () => {
    // Card suppressed → chosenAction undefined → the OLD path stopped (null).
    expect(postDebateContinuation(undefined, SYNTH)).toBeNull();
    // New path always hands the synthesis to the agent.
    expect(buildNeutralPostCouncilContinuation(SYNTH)).toContain(SYNTH);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/convene-path.test.ts -t "continuation source"`
Expected: FAIL — `buildNeutralPostCouncilContinuation` import resolves (Task 1 shipped) but the test file may need the import added; if Task 1 is merged this fails only if the assertion is wrong. If it passes immediately, that's acceptable (it locks the contract) — proceed.

- [ ] **Step 3: Pass convenePath at the /council slash dispatch**

In `src/ui/use-app-logic.tsx`, the dispatch at line 4640 reads:

```tsx
                const gen = agent.runCouncilV2(topic);
```

Change to:

```tsx
                const gen = agent.runCouncilV2(topic, { convenePath: true });
```

Verify the edit landed (file has a NUL byte; normal Grep sees it as binary):

Run: `rg -a -n "runCouncilV2\(topic, \{ convenePath: true \}\)" src/ui/use-app-logic.tsx`
Expected: one match at ~line 4640.

- [ ] **Step 4: Swap the /council continuation builder**

In `src/orchestrator/orchestrator.ts`, the import at line 2063:

```ts
    const { runCouncil, postDebateContinuation } = await import("../council/index.js");
```

change to:

```ts
    const { runCouncil, buildNeutralPostCouncilContinuation } = await import("../council/index.js");
```

Then the continuation at line 2185:

```ts
      const continuationPrompt = ownsController && synthesis ? postDebateContinuation(chosenAction, synthesis) : null;
```

change to:

```ts
      // convenePath suppresses the hardcoded card (chosenAction stays undefined),
      // so always hand the synthesis to a normal agent turn via the neutral
      // continuation and let the agent decide. ownsController scopes this to the
      // top-level /council slash path (auto-council nests with ownsController
      // false and continues in tool-engine instead).
      const continuationPrompt =
        ownsController && synthesis ? buildNeutralPostCouncilContinuation(synthesis) || null : null;
```

> `isBuildContinuation` (next line, `chosenAction === "implement" || … "generate_plan"`)
> now always evaluates `false`, so the isolated-sub-agent branch (2187-2249)
> self-disables and the neutral prompt flows into the watchdog-guarded
> `else if (continuationPrompt)` branch (2250-2285). Leave that line and both
> branches unchanged — no dead-code removal in this task.

- [ ] **Step 5: Typecheck + tests**

Run: `bunx tsc --noEmit`
Expected: 0 errors (confirms no other caller in `orchestrator.ts` still references the removed `postDebateContinuation` import).
Run: `bunx vitest run src/council/__tests__/convene-path.test.ts src/council/__tests__/post-debate-continuation.test.ts`
Expected: PASS (post-debate-continuation tests still green — the function is untouched).

- [ ] **Step 6: Commit**

```bash
git add src/ui/use-app-logic.tsx src/orchestrator/orchestrator.ts src/council/__tests__/convene-path.test.ts
git commit -m "feat(council): /council slash uses convenePath + neutral continuation"
```

---

### Task 4: Close the clarifier scope-research heartbeat gap

The clarifier's scope-research calls `llm.research` directly (no `tracedAsync`), so it emits no `council_status` tick — a monitor watching `council-speaker` elapsedMs sees a frozen signal and mis-reads a long clarification as a stall. Wrap it in `tracedAsync` like debate-research.

**Files:**
- Modify: `src/council/clarifier.ts` (export `researchScopeForClarification` for test; wrap the `llm.research` call at line 351)
- Test: `src/council/__tests__/clarifier-heartbeat.test.ts`

**Interfaces:**
- Consumes: `tracedAsync` from `./llm.js` (signature: `tracedAsync<T>(fn: () => Promise<T>, args: { phase: CouncilStatusPhase; label: string; detail?: string; role?: string; tickIntervalMs?: number }): AsyncGenerator<StreamChunk, T>`).
- Produces: `export async function* researchScopeForClarification(...)` (add `export` to the existing declaration at line 301) — behavior unchanged except it now yields `council_status` `start`/`tick`/`done` chunks while research runs.

- [ ] **Step 1: Write the failing test**

Create `src/council/__tests__/clarifier-heartbeat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { researchScopeForClarification } from "../clarifier.js";
import type { StreamChunk } from "../../types/index.js";

describe("researchScopeForClarification heartbeat", () => {
  it("emits council_status ticks while llm.research is in flight", async () => {
    // llm.research resolves after ~2.5 ticks (tickInterval 1000ms) so at least
    // one "tick" council_status must be yielded before it returns.
    const llm = {
      research: () => new Promise<string>((r) => setTimeout(() => r("brief text"), 2500)),
    } as unknown as Parameters<typeof researchScopeForClarification>[0];

    const chunks: StreamChunk[] = [];
    // Match the real call signature of researchScopeForClarification (topic,
    // conversationContext, llm, signal?) — copy it from clarifier.ts:301.
    const gen = researchScopeForClarification("narrow this scope", "", llm, undefined);
    let out = "";
    for await (const c of gen) {
      chunks.push(c);
    }
    out = ""; // return value captured separately below if needed

    const statuses = chunks.filter((c) => c.type === "council_status");
    expect(statuses.some((c) => (c as { councilStatus?: { state?: string } }).councilStatus?.state === "tick")).toBe(true);
  }, 10_000);
});
```

> NOTE for implementer: open `src/council/clarifier.ts:301` and copy the EXACT
> parameter list of `researchScopeForClarification` into the `gen = ...` call.
> If it takes an options object or different arg order, adjust the test call to
> match. The test's contract is only: a `tick` council_status is emitted.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/clarifier-heartbeat.test.ts`
Expected: FAIL — either `researchScopeForClarification is not exported`, or (once exported) no `tick` status is emitted because `llm.research` is awaited directly.

- [ ] **Step 3: Export the function + wrap the research call**

In `src/council/clarifier.ts`:

(a) Line 301 — add `export`:

```ts
export async function* researchScopeForClarification(
```

(b) Ensure `tracedAsync` is imported at the top of the file. If not present, add to the existing `./llm.js` import (check the top of the file first):

```ts
import { tracedAsync } from "./llm.js";
```

(c) Replace the direct research call (lines 351-353):

```ts
    const brief = await llm.research(researchModel, goal, conversationContext, signal, undefined, {
      internetFirst: webTier !== "none",
    });
```

with a `tracedAsync`-wrapped version that emits the heartbeat:

```ts
    const brief = yield* tracedAsync(
      () =>
        llm.research(researchModel, goal, conversationContext, signal, undefined, {
          internetFirst: webTier !== "none",
        }),
      { phase: "clarify", label: "Scope research" },
    );
```

> `tracedAsync` re-throws on failure AFTER yielding an `error` council_status,
> so the existing `try/catch` (which yields `phaseError` and returns `""`) still
> triggers — the error path is preserved. The extra `error` status is harmless
> (the harness maps it to `done`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/clarifier-heartbeat.test.ts`
Expected: PASS — at least one `tick` council_status emitted.

- [ ] **Step 5: Commit**

```bash
git add src/council/clarifier.ts src/council/__tests__/clarifier-heartbeat.test.ts
git commit -m "fix(council): clarifier scope-research emits tracedAsync heartbeat"
```

---

### Task 5: Full verification + harness E2E

Prove the redesign end-to-end and clear the pre-push gate.

**Files:**
- Test (optional, if a gap surfaces): `tests/harness/council-flow.spec.ts` (existing; extend rather than create)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: green full suite + green harness council flow.

- [ ] **Step 1: Full unit suite**

Run: `bunx vitest run`
Expected: 0 failures. If `post-debate-continuation.test.ts` or any council test fails, STOP and fix before continuing (Pre-Push Test Gate — no push on red).

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Harness E2E — /council concludes without a post-debate askcard**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/council-flow.spec.ts`
Expected: PASS. If the existing spec asserts the OLD post-debate card appears, update that assertion to expect NO askcard after synthesis and a normal continuation instead (the card is intentionally gone). Drive in a greenfield temp cwd per the spec's known-caveat #2 so the scan is instant.

- [ ] **Step 4: Self-verify watched surfaces (UI touched)**

`src/ui/use-app-logic.tsx` is a watched surface. Run Tier 1:

Run: `bun run src/index.ts self-verify --since HEAD~5 --max 4`
Expected: scenarios pass (no modal/focus regression from the slash change).

- [ ] **Step 5: Commit any spec/self-verify artifacts**

```bash
git add tests/harness/ .husky/ 2>/dev/null; git commit -m "test(council): harness coverage for agent-driven post-council" || echo "no test artifacts to commit"
```

- [ ] **Step 6: Push (only after green)**

```bash
git push -u origin feat/convene-council-tool
```

Expected: pre-push hook (Tier 1 self-verify on watched surfaces) passes; push succeeds.

---

## Follow-ups (out of scope — flag, do not implement here)

- **`runDebate` builtin tool** (`tool-engine.ts:1018-1027`): a model-callable path that drains `runCouncilV2` WITHOUT `convenePath`, so it still shows the hardcoded card. It uses `userModelMessage: /council ${topic}`. Whether it should also adopt `convenePath:true` (same principle) is a separate decision — surface to the user; do not change it in this plan.
- **Delete `postDebateContinuation`**: grep shows the two redesigned sites were its only callers; after this plan only its own test references it. A future cleanup can remove it + its test once `/ideal` independence is confirmed by running the `/ideal` suite (its inline comment claims reliance the current grep does not corroborate).

## Self-Review

**Spec coverage:**
- Spec §1 (unify onto convenePath): Tasks 2 (auto-council) + 3 (/council). ✓
- Spec §2 (replace postDebateContinuation with neutral continuation): Task 1 (builder) + Tasks 2/3 (wiring). ✓
- Spec §3 (clarifier heartbeat): Task 4. ✓
- Spec "out of scope /ideal + convene": Global Constraints scope-lock + Follow-ups note. ✓
- Spec Testing bullets: Tasks 1-4 unit tests + Task 5 harness E2E + full-suite gate. ✓

**Type consistency:** `buildNeutralPostCouncilContinuation(synthesis: string): string` used identically in Tasks 1/2/3. `researchScopeForClarification` exported in Task 4 matches the test import. `convenePath` matches the existing `runCouncilV2` option (`orchestrator.ts:2060`) and `runCouncil` option (`index.ts:156`).

**Placeholder scan:** No TBD/TODO. Test-construction steps that depend on existing test scaffolding (Task 2 deps, Task 4 arg list) carry explicit NOTE-for-implementer instructions to copy the exact adjacent signature rather than guess — deliberate, because the neighbouring code is the ground truth.
