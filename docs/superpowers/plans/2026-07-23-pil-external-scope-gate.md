# PIL External-Scope Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the pipeline from reading/searching the current repository when the model classifies a turn as an out-of-repo ("external") question, while keeping today's behaviour for in-repo/ecosystem/unknown turns.

**Architecture:** Widen the model-decided classify `scope` field from `{ecosystem|local}` to `{ecosystem|local|external}`, surface it as `scopeKind` on the PIL `PipelineContext`, and gate the three codebase-reading behaviours on `scopeKind === "external"`: (A) the council research + grounding-verify phase, (B) the discovery scan, (C) the layer5 recent-files index. Emit a `scope-gate` decision-log entry when suppression fires so a false-external is auditable. Fail-open: null/parse-failure/`local`/`ecosystem` all ground exactly as today.

**Tech Stack:** TypeScript, bun, vitest. PIL classify path (`src/pil/`), council (`src/council/`), decision-log (`src/usage/`).

## Global Constraints

- **Zero-Hardcode (muonroi-cli/CLAUDE.md):** no model/provider ID string literals, no keyword/regex table for scope. `scopeKind` is entirely model-decided.
- **No Silent Catch (Core/CLAUDE.md):** every `catch` logs module + operation + `err.message`.
- **Fail-open direction:** absence of a confident `external` MUST behave exactly as today. Any null/unknown → grounded.
- **Classify contract stays 8 words:** `<taskType>,<style>,<intent>,<deliverable>,<depth>,<scope>,<lang>,<clarity>`. Do NOT add a 9th word.
- **Pre-Push Test Gate:** full `bunx vitest run` = 0 failures before any push; plus `bunx vitest -c vitest.harness.config.ts run tests/harness/` for the harness task.
- **Reply language:** code/comments/commits in English.

---

## File Structure

- **Modify** `src/pil/llm-classify.ts` — add `"external"` to `KNOWN_CLASSIFY_WORDS`; parse `scopeWord` 3-way; add `scopeKind` to `LlmClassifyResult`; update `SYSTEM_PROMPT` scope section + examples.
- **Modify** `src/pil/types.ts` — add `scopeKind?: "ecosystem" | "local" | "external" | null` to `PipelineContext`.
- **Modify** `src/pil/layer1-intent.ts` — map `scopeKind: llmRes.scopeKind` into the intent result.
- **Modify** `src/pil/pipeline.ts` — Gate B (discovery guard) + Gate E (decision-log emit after layer1).
- **Modify** `src/pil/layer5-context.ts` — Gate C (recent-files guard).
- **Modify** `src/usage/decision-log.ts` — add `"scope-gate"` to `DecisionKind`.
- **Modify** `src/council/types.ts` — add `externalTopic?: boolean` to `CouncilConfig`.
- **Modify** `src/council/debate.ts` — Gate A (fold `externalTopic` into `needsResearch` + grounding-verify guard).
- **Modify** `src/council/index.ts` — derive `externalTopic` from `pilCtx.scopeKind` and pass into the debate config.
- **Modify** test fixtures: `src/pil/__tests__/pipeline.test.ts`, `src/pil/layer1-intent.test.ts` (add `scopeKind` to classify-result literals).
- **Modify/Create** unit tests: `src/pil/__tests__/llm-classify.test.ts`, `src/pil/__tests__/layer5-context.test.ts` (or existing), `src/council/__tests__/debate.test.ts`/`grounding-verify.test.ts`, `src/usage/__tests__/decision-log.test.ts`.
- **Create** `tests/harness/external-scope.spec.ts` — E2E behaviour.

**Deferred (NOT in this plan — follow-up, needs its own investigation):** Gate D (hard gate on the main-loop `task`/`delegate` explore dispatch in `src/tools/registry.ts`). The observed 613K leak was 100% council-internal (Gate A). The main-loop delegation path is unobserved and requires locating the tool-construction seam where `pilCtx` is reachable; opening that here would add placeholder risk. Ship A/B/C/E first, then scope Gate D as a separate plan.

---

## Task 1: Add `scopeKind` to the classifier (parse + type + prompt)

**Files:**
- Modify: `src/pil/llm-classify.ts` (interface ~53-107, `KNOWN_CLASSIFY_WORDS` ~319-343, `SYSTEM_PROMPT` ~366-411, `parseResponse` ~420-476)
- Test: `src/pil/__tests__/llm-classify.test.ts`

**Interfaces:**
- Produces: `LlmClassifyResult.scopeKind: "ecosystem" | "local" | "external" | null` (required-nullable field). `ecosystemScope` remains `boolean | null` derived from the same word.

- [ ] **Step 1: Write the failing test** — append to `src/pil/__tests__/llm-classify.test.ts` inside the existing top-level `describe`:

```ts
  it("parses external scope and keeps language + ecosystemScope correct", async () => {
    const ext = installMockModel({
      fixture: { stream: textOnlyStream("analyze,concise,task,answer,heavy,external,vietnamese,clear") },
    });
    cleanup = ext.uninstall;
    const extClassify = createLlmClassifier("deepseek-v4-flash");
    const r = await extClassify("giải thích CAP theorem");
    expect(r?.scopeKind).toBe("external");
    // external is NOT the ecosystem — no docs nudge, and it must not be
    // swallowed as the reply language.
    expect(r?.ecosystemScope).toBe(false);
    expect(r?.replyLanguage).toBe("Vietnamese");
    ext.uninstall();

    // local stays local; the overloaded `false` ecosystemScope bucket is covered.
    const loc = installMockModel({
      fixture: { stream: textOnlyStream("debug,concise,task,code,standard,local,english,clear") },
    });
    cleanup = loc.uninstall;
    const locClassify = createLlmClassifier("deepseek-v4-flash");
    const p = await locClassify("fix the crash");
    expect(p?.scopeKind).toBe("local");
    expect(p?.ecosystemScope).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/llm-classify.test.ts -t "parses external scope"`
Expected: FAIL — `r.scopeKind` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add `"external"` to `KNOWN_CLASSIFY_WORDS`** — in `src/pil/llm-classify.ts`, in the set literal (~319-343), add after `"local",`:

```ts
  "local",
  "external",
  "clear",
```

- [ ] **Step 4: Add the `scopeKind` field to `LlmClassifyResult`** — immediately after the `ecosystemScope: boolean | null;` field (~line 98):

```ts
  ecosystemScope: boolean | null;
  /**
   * Model-decided repo relevance (widened `scope`): "ecosystem" (Muonroi
   * PLATFORM/docs), "local" (this repo's own code), or "external" (NOT about any
   * codebase in this repo — a general/conceptual/out-of-repo question). null when
   * the model omitted/garbled the word. Drives the external-scope gate: only a
   * confident "external" suppresses repo grounding. `ecosystemScope` above stays
   * derived from the same word (=== "ecosystem").
   */
  scopeKind: "ecosystem" | "local" | "external" | null;
```

- [ ] **Step 5: Parse the widened scope in `parseResponse`** — replace the scope block (~448-450):

```ts
  // Sixth word is the scope. "ecosystem" → platform/docs-authoritative turn;
  // "local" → this repo's own code; "external" → not about any repo codebase.
  // Anything else (incl. absent) → null. Position-independent.
  const scopeWord = parts.find((p) => p === "ecosystem" || p === "local" || p === "external");
  const scopeKind: "ecosystem" | "local" | "external" | null =
    scopeWord === "ecosystem" || scopeWord === "local" || scopeWord === "external" ? scopeWord : null;
  const ecosystemScope: boolean | null = scopeWord ? scopeWord === "ecosystem" : null;
```

- [ ] **Step 6: Return `scopeKind`** — in the returned object literal (~465-475), add after `ecosystemScope,`:

```ts
    ecosystemScope,
    scopeKind,
    replyLanguage,
```

- [ ] **Step 7: Update `SYSTEM_PROMPT` scope definition** — replace the two scope lines (~366-368):

```ts
  "scope ∈ { ecosystem | local | external }:\n" +
  "- ecosystem — the turn is about the Muonroi PLATFORM as a whole: the building-block / .NET packages, open-core boundary, the rule engine / decision tables, NuGet packages, or platform setup/install. These are documented in an authoritative docs source.\n" +
  "- local — a question about THIS project's own code/repo (this CLI's internals, its files, its behaviour), even when it mentions the word 'muonroi'.\n" +
  "- external — the turn is NOT about any codebase in this repository: a general/conceptual question, an external-world analysis, a strategy/design debate about something outside this project's code. When unsure between local and external, choose local (the safe grounding default).\n" +
```

- [ ] **Step 8: Add two `external` examples** — in the examples block (~394-410), add after the `'plan the migration to hooks'` line:

```ts
  "- 'plan the migration to hooks' → plan,balanced,task,report,heavy,local,english,clear\n" +
  "- 'giải thích CAP theorem' → analyze,concise,task,answer,standard,external,vietnamese,clear\n" +
  "- 'design a council debate about pricing strategy for a SaaS product' → plan,balanced,task,report,heavy,external,english,clear\n" +
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `bunx vitest run src/pil/__tests__/llm-classify.test.ts -t "parses external scope"`
Expected: PASS.

- [ ] **Step 10: Run the whole classify test file to catch regressions**

Run: `bunx vitest run src/pil/__tests__/llm-classify.test.ts`
Expected: all PASS (the existing "parses the sixth + seventh words" test still asserts only `ecosystemScope`/`replyLanguage` and is unaffected).

- [ ] **Step 11: Commit**

```bash
git add src/pil/llm-classify.ts src/pil/__tests__/llm-classify.test.ts
git commit -m "feat(pil): add external scope kind to classifier"
```

---

## Task 2: Thread `scopeKind` onto `PipelineContext`

**Files:**
- Modify: `src/pil/types.ts` (~71-86, `PipelineContext`)
- Modify: `src/pil/layer1-intent.ts` (~701-735)
- Modify: `src/pil/__tests__/pipeline.test.ts` (line 87), `src/pil/layer1-intent.test.ts` (lines 92,257,286,319,343,363,382,399)

**Interfaces:**
- Consumes: `LlmClassifyResult.scopeKind` (Task 1).
- Produces: `PipelineContext.scopeKind?: "ecosystem" | "local" | "external" | null`, set by layer1-intent. Gates in Tasks 4/5/7 read `ctx.scopeKind === "external"`.

- [ ] **Step 1: Add the field to `PipelineContext`** — in `src/pil/types.ts`, after the `ecosystemScope?: boolean | null;` field (~line 78):

```ts
  ecosystemScope?: boolean | null;
  /**
   * Model-decided repo relevance (widened scope): "external" means the turn is
   * NOT about any codebase in this repo. Set by layer1's classifier; read by the
   * discovery/layer5/council gates to suppress repo grounding. null/undefined →
   * treated as relevant (fail-open).
   */
  scopeKind?: "ecosystem" | "local" | "external" | null;
```

- [ ] **Step 2: Map it in layer1-intent** — in `src/pil/layer1-intent.ts`, in the returned object (~720), after `ecosystemScope: llmRes.ecosystemScope,`:

```ts
          ecosystemScope: llmRes.ecosystemScope,
          scopeKind: llmRes.scopeKind,
          replyLanguage: llmRes.replyLanguage,
```

- [ ] **Step 3: Fix the classify-result fixtures (they now miss a required field)** — in `src/pil/__tests__/pipeline.test.ts:87` add `scopeKind` next to `ecosystemScope: null`:

```ts
        ecosystemScope: null,
        scopeKind: null,
        replyLanguage: null,
```

- [ ] **Step 4: Fix all 8 fixtures in `layer1-intent.test.ts`** — at each `ecosystemScope: null,` line (92, 257, 286, 319, 343, 363, 382, 399), add `scopeKind: null,` immediately after. (Search-replace `ecosystemScope: null,` → `ecosystemScope: null,\n        scopeKind: null,`, matching the file's indentation.)

- [ ] **Step 5: Run the PIL test suite to verify it compiles + passes**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts src/pil/layer1-intent.test.ts`
Expected: all PASS (0 TS errors for missing `scopeKind`).

- [ ] **Step 6: Typecheck the whole project**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/pil/types.ts src/pil/layer1-intent.ts src/pil/__tests__/pipeline.test.ts src/pil/layer1-intent.test.ts
git commit -m "feat(pil): surface scopeKind on PipelineContext"
```

---

## Task 3: Add the `scope-gate` decision kind

**Files:**
- Modify: `src/usage/decision-log.ts` (~23-28, `DecisionKind`)
- Test: `src/usage/__tests__/decision-log.test.ts` (create if absent)

**Interfaces:**
- Produces: `DecisionKind` now includes `"scope-gate"`. Used by Task 4's `appendDecisionLog` emit.

- [ ] **Step 1: Write the failing test** — create/append `src/usage/__tests__/decision-log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDecisionLog, readDecisionLog } from "../decision-log.js";

describe("decision-log scope-gate kind", () => {
  it("accepts and round-trips a scope-gate entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "declog-"));
    await appendDecisionLog(
      { ts: 1, sessionId: "s1", kind: "scope-gate", taken: false, reason: "external", meta: { scopeKind: "external" } },
      home,
    );
    const rows = await readDecisionLog(home);
    expect(rows.some((r) => r.kind === "scope-gate")).toBe(true);
  });
});
```

(If `readDecisionLog` does not exist, read `src/usage/decision-log.ts` and assert against whatever read/parse helper it exports; the point of the test is that TS accepts `kind: "scope-gate"`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/usage/__tests__/decision-log.test.ts`
Expected: FAIL — TS rejects `"scope-gate"` as it is not in `DecisionKind`.

- [ ] **Step 3: Add the kind** — in `src/usage/decision-log.ts`, extend the `DecisionKind` union (~23-28):

```ts
export type DecisionKind =
  | "auto-council"
  | "post-turn-compact"
  | "router-tier"
  | "permission-override"
  | "yolo-override"
  | "scope-gate";
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/usage/__tests__/decision-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage/decision-log.ts src/usage/__tests__/decision-log.test.ts
git commit -m "feat(usage): add scope-gate decision kind"
```

---

## Task 4: Gate B (discovery) + Gate E (decision-log emit) in the pipeline

**Files:**
- Modify: `src/pil/pipeline.ts` (layer1 call ~109-115, discovery guard ~170)
- Test: `src/pil/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `ctx.scopeKind` (Task 2), `appendDecisionLog` + `"scope-gate"` (Task 3).
- Produces: discovery scan skipped when `ctx.scopeKind === "external"`; one `scope-gate` decision-log entry per external turn.

- [ ] **Step 1: Write the failing test** — append to `src/pil/__tests__/pipeline.test.ts`:

```ts
  it("skips discovery for an external-scope turn", async () => {
    let discoveryProbed = false;
    const ctx = await runPipeline("explain the CAP theorem tradeoffs", {
      llmFallback: async () => ({
        taskType: "analyze" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "task" as const,
        deliverableKind: "answer" as const,
        depthTier: "heavy" as const,
        needsClarification: null,
        ecosystemScope: false,
        scopeKind: "external" as const,
        replyLanguage: null,
      }),
      clarificationProposer: async () => {
        discoveryProbed = true;
        return null;
      },
    });
    expect(ctx.scopeKind).toBe("external");
    // discovery must not have engaged the clarification proposer for an
    // out-of-repo question.
    expect(discoveryProbed).toBe(false);
  });
```

(If `runPipeline`'s options do not accept `clarificationProposer`, assert instead that no `layer` entry named a discovery interview ran — check `ctx.layers` for the discovery marker the existing tests use. Read the existing pipeline test helpers first.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts -t "skips discovery for an external"`
Expected: FAIL — discovery still runs (guard does not yet check scope).

- [ ] **Step 3: Add the discovery guard** — in `src/pil/pipeline.ts`, the discovery trigger (~170):

```ts
  // Phase 1 discovery: L1.5–L1.8 (interactive, no hard timeout).
  // External-scope turns (not about this repo) skip the repo scan entirely.
  if (isDiscoveryEnabled() && ctx.intentKind !== "chitchat" && ctx.scopeKind !== "external") {
```

- [ ] **Step 4: Emit the scope-gate decision log** — in `src/pil/pipeline.ts`, immediately after the `await timed("layer1-intent", ...)` block (~115), add:

```ts
  if (ctx.scopeKind === "external") {
    const { appendDecisionLog } = await import("../usage/decision-log.js");
    appendDecisionLog({
      ts: Date.now(),
      sessionId: ctx.sessionId ?? null,
      kind: "scope-gate",
      taken: false, // grounding suppressed → the expensive repo-read path is NOT taken
      reason: "external-scope: repo grounding suppressed (discovery/layer5/council research)",
      meta: {
        scopeKind: ctx.scopeKind,
        taskType: ctx.taskType ?? null,
        confidence: ctx.confidence,
      },
    }).catch((err) =>
      console.error(`[pipeline] scope-gate decision-log write failed: ${(err as Error)?.message}`),
    );
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts -t "skips discovery for an external"`
Expected: PASS.

- [ ] **Step 6: Run the full pipeline test file**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts`
Expected: all PASS (in-repo/`local` turns still run discovery — the existing tests cover that).

- [ ] **Step 7: Commit**

```bash
git add src/pil/pipeline.ts src/pil/__tests__/pipeline.test.ts
git commit -m "feat(pil): gate discovery + log scope-gate for external turns"
```

---

## Task 5: Gate C (layer5 recent-files)

**Files:**
- Modify: `src/pil/layer5-context.ts` (~156-168)
- Test: `src/pil/__tests__/layer5-context.test.ts` (create if absent)

**Interfaces:**
- Consumes: `ctx.scopeKind` (Task 2).
- Produces: `fetchRecentFiles` not called when `ctx.scopeKind === "external"`.

- [ ] **Step 1: Write the failing test** — create/append `src/pil/__tests__/layer5-context.test.ts`. Build a minimal `PipelineContext` and assert the recent-files delta is skipped:

```ts
import { describe, expect, it } from "vitest";
import { layer5Context } from "../layer5-context.js";
import type { PipelineContext } from "../types.js";

function baseCtx(over: Partial<PipelineContext>): PipelineContext {
  return {
    raw: "explain the CAP theorem",
    enriched: "explain the CAP theorem",
    taskType: "analyze",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 8000,
    metrics: null,
    layers: [],
    intentKind: "task",
    ...over,
  } as PipelineContext;
}

describe("layer5 external-scope gate", () => {
  it("skips recent-files indexing for an external turn", async () => {
    const ctx = await layer5Context(baseCtx({ scopeKind: "external" }));
    const l5 = ctx.layers.find((l) => l.name === "context-enrichment");
    expect(l5?.delta ?? "").not.toContain("files=");
  });
});
```

(Read `layer5-context.ts` for the exact `layers` name it appends — it uses `"context-enrichment"`; adjust the assertion to match the real delta text, which includes `files=…ch` or `files=skipped-operational` on the grounded path.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer5-context.test.ts`
Expected: FAIL — the delta still contains `files=…` because recent-files ran.

- [ ] **Step 3: Add the guard** — in `src/pil/layer5-context.ts`, the recent-files block (~159):

```ts
  if (!skipRecentFiles && ctx.scopeKind !== "external") {
    const filesBudget = Math.floor(ctx.tokenBudget * 0.03);
    const fileIndex = await fetchRecentFiles(cwd, filesBudget);
    if (fileIndex) {
      parts.push(fileIndex);
      deltaSegments.push(`files=${fileIndex.length}ch`);
    }
  } else {
    deltaSegments.push(ctx.scopeKind === "external" ? "files=skipped-external" : "files=skipped-operational");
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/pil/__tests__/layer5-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer5-context.ts src/pil/__tests__/layer5-context.test.ts
git commit -m "feat(pil): gate layer5 recent-files for external turns"
```

---

## Task 6: Gate A (council research + grounding-verify)

**Files:**
- Modify: `src/council/types.ts` (`CouncilConfig` ~283-373)
- Modify: `src/council/debate.ts` (destructure ~564 & internetFirst ~592, `needsResearch` ~645-650, grounding-verify guard ~1921-1925)
- Modify: `src/council/index.ts` (derive after pilCtx ~505-508, pass into config ~744-785)
- Test: `src/council/__tests__/debate.test.ts` (or the existing `grounding-verify.test.ts`)

**Interfaces:**
- Consumes: `pilCtx.scopeKind` (Task 2, computed inside `runCouncil` at index.ts:505).
- Produces: `CouncilConfig.externalTopic?: boolean`. When true, `runDebate` runs no research phase and no grounding-verify (no repo read via any of the three sub-paths); council still convenes + synthesizes.

- [ ] **Step 1: Write the failing test** — add to `src/council/__tests__/debate.test.ts` (create if absent; mirror the `grounding-verify.test.ts` import style). Drive `runDebate` with a `runIsolatedTask` spy and `externalTopic: true`, assert the spy is never called:

```ts
import { describe, expect, it } from "vitest";
import { runDebate } from "../debate.js";
// ...import/construct a minimal ClarifiedSpec, CouncilLLM stub, and participants
// following the patterns already used in src/council/__tests__.

describe("council external-topic gate", () => {
  it("skips research + grounding-verify when externalTopic is set", async () => {
    let isolatedCalled = false;
    const gen = runDebate(
      /* spec */ minimalSpec(),
      {
        topic: "pricing strategy debate",
        conversationContext: "",
        leaderModelId: "deepseek-v4-flash",
        participants: minimalParticipants(),
        externalTopic: true,
        runIsolatedTask: async () => {
          isolatedCalled = true;
          return { success: true, output: "ignored" };
        },
      } as any,
      stubLLM(),
    );
    // drain the generator
    // eslint-disable-next-line no-empty
    for await (const _ of gen) { /* consume */ }
    expect(isolatedCalled).toBe(false);
  });
});
```

(Read `src/council/__tests__/grounding-verify.test.ts` and `debate.ts` first to reuse the existing spec/participant/LLM stub helpers so this compiles.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/council/__tests__/debate.test.ts -t "skips research"`
Expected: FAIL — `externalTopic` is not a `CouncilConfig` field / research still runs.

- [ ] **Step 3: Add the config field** — in `src/council/types.ts`, in `CouncilConfig`, next to `internetFirst?` (~304):

```ts
  /** When true, the working directory has no source code yet — research prompt prefers internet sources. */
  internetFirst?: boolean;
  /**
   * When true, the turn is an out-of-repo ("external") question: runDebate skips
   * the research phase AND grounding-verify so no council sub-path reads the repo.
   * Council still convenes + debates + synthesizes on model knowledge.
   */
  externalTopic?: boolean;
```

- [ ] **Step 4: Fold `externalTopic` into `needsResearch`** — in `src/council/debate.ts`, add the const near `internetFirst` (~592) and update the `needsResearch` computation (~645-650):

```ts
  const internetFirst = config.internetFirst === true;
  const externalTopic = config.externalTopic === true;
```

```ts
  const needsResearch = resumed
    ? false
    : externalTopic
      ? false
      : researchSkipOverride
        ? false
        : (leaderNeedsResearch ??
          (yield* evaluateResearchNeed(spec, leaderModelId, conversationContext, llm, costAware)));
```

- [ ] **Step 5: Gate grounding-verify** — in `src/council/debate.ts`, the grounding-verify condition (~1921):

```ts
    if (
      config.runIsolatedTask &&
      !externalTopic &&
      groundingVerifyEnabled() &&
      !signal?.aborted &&
      computeEvidenceDensity(preText) < GROUNDING_VERIFY_THRESHOLD
    ) {
```

- [ ] **Step 6: Derive + pass `externalTopic` in `runCouncil`** — in `src/council/index.ts`, after the pilCtx block (~508), add:

```ts
  const externalTopic = pilCtx?.scopeKind === "external";
```

Then in the `runDebate` config object (~744-785), add next to `internetFirst,`:

```ts
      internetFirst,
      externalTopic,
      costAware,
```

- [ ] **Step 7: Run to verify it passes**

Run: `bunx vitest run src/council/__tests__/debate.test.ts -t "skips research"`
Expected: PASS.

- [ ] **Step 8: Run the council test suite + typecheck**

Run: `bunx vitest run src/council/__tests__/ && bunx tsc --noEmit`
Expected: all PASS, 0 TS errors.

- [ ] **Step 9: Commit**

```bash
git add src/council/types.ts src/council/debate.ts src/council/index.ts src/council/__tests__/debate.test.ts
git commit -m "feat(council): skip research + grounding-verify for external topics"
```

---

## Task 7: Harness E2E — external prompt does not read the repo

**Files:**
- Create: `tests/harness/external-scope.spec.ts`
- Create: `tests/harness/fixtures/llm/external-scope.json` (if the harness fixture format is needed)

**Interfaces:**
- Consumes: the full stack (Tasks 1-6) via a real spawned TUI.

- [ ] **Step 1: Write the spec** — follow the `tests/harness/helpers.ts` `spawnHarness` pattern (read an existing spec such as `tests/harness/events.spec.ts` first). Drive an external-analysis prompt in a **fresh greenfield temp cwd** (per the council-flow caveat in CLAUDE.md) with a mock-LLM fixture whose classify reply is `analyze,concise,task,answer,heavy,external,english,clear`. Assert: no `route-decision`/event indicating a codebase explore sub-agent, and the turn still completes. Concretely, subscribe to events and assert no `sprint`/explore `subagent` codebase read fired, or assert `driver.last_event(...)` shows the council debated without a research phase.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers";

describe("external-scope: out-of-repo analysis skips codebase read", () => {
  let h: Awaited<ReturnType<typeof spawnHarness>>;
  beforeAll(async () => {
    h = await spawnHarness({ mockLlmFixture: "external-scope", cwd: /* fresh temp dir */ undefined });
    await h.driver.wait_for({ idle: true, timeoutMs: 20_000 });
  }, 30_000);
  afterAll(() => h?.stop());

  it("does not spawn a codebase explore sub-agent for an external question", async () => {
    h.driver.type("analyze the tradeoffs of microservices vs monolith");
    h.driver.press("Enter");
    await h.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    // No council research / explore-over-repo event should have fired.
    const research = h.driver.last_event("council-step");
    expect(
      !research || !(research as any).phaseKind || (research as any).phaseKind !== "research",
    ).toBe(true);
  });
});
```

(Adjust the exact assertion to the real event kinds in `docs/agent-harness/PROTOCOL.md`; the invariant is "no research/explore phase read the repo for an external prompt.")

- [ ] **Step 2: Run the harness spec (Windows named-pipe path)**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/external-scope.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/harness/external-scope.spec.ts tests/harness/fixtures/llm/external-scope.json
git commit -m "test(harness): external prompt skips codebase read (E2E)"
```

---

## Task 8: Full-suite gate + self-verify

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Full unit suite**

Run: `bunx vitest run`
Expected: 0 failures. (If any classify-result fixture outside the ones in Task 2 breaks on the new required `scopeKind`, add `scopeKind: null` there and re-run — grep `ecosystemScope:` across `src` and `tests` to find them all.)

- [ ] **Step 3: Harness suite for touched surfaces**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/`
Expected: 0 failures (or unchanged skip baseline).

- [ ] **Step 4: Self-verify (watched surfaces touched: none in src/ui, but pipeline/council are behaviour-critical)**

Run: `bun run src/index.ts self-verify --since HEAD~8 --max 4`
Expected: no scenario regressions.

- [ ] **Step 5: Final commit if any fixture sweep was needed**

```bash
git add -A
git commit -m "test(pil): backfill scopeKind in remaining classify fixtures"
```

---

## Self-Review

**Spec coverage:**
- Field widening (spec §1-2) → Task 1. ✅
- PIL wiring (spec §3) → Task 2. ✅
- Gate A council research + grounding-verify (spec §4 Gate A) → Task 6. ✅
- Gate B discovery (spec §4 Gate B) → Task 4. ✅ (gated at `pipeline.ts:170` call-site per review, not `discovery.ts:73`).
- Gate C layer5 (spec §4 Gate C) → Task 5. ✅
- Gate E observability (spec §4 Gate E) → Task 3 (kind) + Task 4 (emit). ✅
- Gate D (spec §4 Gate D) → **explicitly deferred** (documented in File Structure "Deferred"); observed leak is Gate A, D is unobserved defense-in-depth. ✅ (conscious scope decision, not a gap).
- `KNOWN_CLASSIFY_WORDS += external` load-bearing (spec §2) → Task 1 Step 3, guarded by the `replyLanguage` assertion in Task 1 Step 1. ✅
- Fixture updates (spec Testing #2) → Task 2 Steps 3-4 + Task 8 Step 2 sweep. ✅
- Fail-open (spec Error handling) → every gate is `!== "external"` / `=== "external"`; null/absent grounds. ✅

**Placeholder scan:** No "TBD/implement later". The two "read the existing helper first" notes (Task 6 Step 1, Task 7) are calibration instructions for reusing existing test scaffolding, with the concrete assertion supplied — not deferred content.

**Type consistency:** `scopeKind: "ecosystem" | "local" | "external" | null` identical in `LlmClassifyResult` (Task 1), `PipelineContext` (Task 2), and all reads (`ctx.scopeKind`, `pilCtx.scopeKind`). `externalTopic: boolean` consistent across `CouncilConfig` (Task 6 Step 3), the destructure (Step 4), and the pass-in (Step 6). Decision kind `"scope-gate"` identical in Task 3 and Task 4.
