# Council intent gate + planner phase + plan-driven execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a council debate end in a reviewed, phased plan that a single "Implement" press executes to completion, instead of a prose conclusion that gets re-classified as a report and produces one shallow step.

**Architecture:** Three seams. (1) An intent block folded into the existing launch card locks `intentKind` on `ClarifiedSpec` *before* any spend, replacing the after-the-fact regex recovery in `synthesisOutputKind`. (2) A new council phase — planner writes `.planning/PLAN.md`, the debate panelists cross-review it with structured verdicts, the leader merges — reusing `src/gsd/verdict-schema.ts` and `src/gsd/workflow-engine.ts` but living in `src/council/` so the GSD perspective union is untouched. (3) A marked execution envelope recognised in `src/pil/pipeline.ts` (exactly how `SPRINT_EXECUTION_MARKER` already works) drives a per-phase loop with a deterministic verify gate that halts on failure.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun runtime, vitest, zod v4, existing council/GSD/PIL modules.

**Spec:** `docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md`

## Global Constraints

- **Zero Hardcode (model/provider):** never write a model or provider id as a string literal. Every model reference resolves through `catalog.json`, `getCurrentModel()`, `detectProviderForModel()`, or catalog lookup. Throw rather than fall back to a literal. UI copy keyed by a TypeScript union is NOT a violation.
- **No Silent Catch:** every `catch` binds the error and logs module name, operation, and `err.message`. `catch {}` and `catch { return null; }` are forbidden. An intentionally-ignored error still logs and carries a comment saying why.
- **Evidence-First:** any claim in a commit message about behaviour cites a file:line, a test name, or captured output.
- **Pre-Push Test Gate:** `bunx tsc --noEmit` clean and `bunx vitest run` fully green (0 failed) before any push. "Pre-existing failure" is not an exemption.
- **Imports:** in-repo ESM imports carry the `.js` extension (`./types.js`), matching every file in `src/council/`.
- **Test location:** unit tests go in `src/council/__tests__/*.test.ts`; harness E2E in `tests/harness/*.spec.ts`.
- **Council language:** user-facing council copy respects `getCouncilLanguage()`; code, comments, and commit messages are English.

---

## File Structure

**Create:**
- `src/council/intent-card.ts` — pure builder for the launch card's intent options + answer parsing. No I/O.
- `src/council/plan-artifact.ts` — the `PlanPhase` model: render `PLAN.md`, parse it back, tick a phase. Pure string/data functions.
- `src/council/plan-phase.ts` — the council phase: planner generation, panelist cross-review, leader merge, artifact + `STATE.md` writes.
- `src/council/plan-execution.ts` — marked per-phase execution prompts, the phase loop, the deterministic verify gate.
- `src/council/__tests__/intent-card.test.ts`
- `src/council/__tests__/plan-artifact.test.ts`
- `src/council/__tests__/plan-phase.test.ts`
- `src/council/__tests__/plan-execution.test.ts`
- `tests/harness/council-plan-gate.spec.ts`

**Modify:**
- `src/council/launch-card.ts` — accept and render the intent block.
- `src/council/types.ts` — `ClarifiedSpec.intentKind`, richer `ActionPlan`.
- `src/council/index.ts` — launch-card wiring, locked-kind propagation, post-plan card, remove the `generate_plan` alias.
- `src/pil/layer6-output.ts` — `COUNCIL_PLAN_EXECUTION_MARKER` + `isCouncilPlanExecution`, and the marker inside `IMPLEMENTATION_INTENT_RE`.
- `src/pil/pipeline.ts:167` — recognise the council marker alongside the sprint marker.
- `src/council/executor.ts` — replaced by the phase loop.

---

### Task 1: Intent option builder

The launch card must offer what the user wants out of the run. Options derive from the `IntentKind` union so adding a kind is a compile error, and the leader's own `debatePlan.outputShape.kind` supplies the recommended pick — no extra LLM call.

**Files:**
- Create: `src/council/intent-card.ts`
- Test: `src/council/__tests__/intent-card.test.ts`

**Interfaces:**
- Consumes: `IntentKind`, `coerceIntentKind` from `src/council/types.ts:294`; `CouncilQuestionOption` from `src/types/index.ts`.
- Produces: `buildIntentOptions(proposedKind: IntentKind, intentSummary: string): CouncilQuestionOption[]`, `parseIntentAnswer(raw: string, fallback: IntentKind): IntentKind`, `INTENT_COPY: Record<IntentKind, { label: string; description: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/intent-card.test.ts
import { describe, expect, it } from "vitest";
import { buildIntentOptions, INTENT_COPY, parseIntentAnswer } from "../intent-card.js";
import { ANALYSIS_INTENT_KINDS, IMPLEMENTATION_INTENT_KINDS, type IntentKind } from "../types.js";

const ALL_KINDS = [...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS] as IntentKind[];

describe("buildIntentOptions", () => {
  it("puts the leader's proposed kind first and carries the intent summary", () => {
    const opts = buildIntentOptions("implementation_plan", "Build the sentinel E2E");
    expect(opts[0].value).toBe("implementation_plan");
    expect(opts[0].description).toContain("Build the sentinel E2E");
  });

  it("offers every IntentKind exactly once", () => {
    const values = buildIntentOptions("evaluation", "x").map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const k of ALL_KINDS) expect(values).toContain(k);
  });

  it("has copy for every kind in the union", () => {
    for (const k of ALL_KINDS) expect(INTENT_COPY[k].label.length).toBeGreaterThan(0);
  });
});

describe("parseIntentAnswer", () => {
  it("accepts a valid kind", () => {
    expect(parseIntentAnswer("implementation_plan", "evaluation")).toBe("implementation_plan");
  });

  it("falls back on junk rather than coercing to a build mandate", () => {
    expect(parseIntentAnswer("", "evaluation")).toBe("evaluation");
    expect(parseIntentAnswer("nonsense", "decision")).toBe("decision");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/intent-card.test.ts`
Expected: FAIL — `Failed to resolve import "../intent-card.js"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/council/intent-card.ts
import type { CouncilQuestionOption } from "../types/index.js";
import { ANALYSIS_INTENT_KINDS, coerceIntentKind, IMPLEMENTATION_INTENT_KINDS, type IntentKind } from "./types.js";

/**
 * User-facing copy per intent kind. Keyed by the union (NOT a free-form list) so
 * adding an IntentKind fails to compile until its copy exists. This is UI copy,
 * not a model/provider literal — the Zero-Hardcode rule does not apply.
 */
export const INTENT_COPY: Record<IntentKind, { label: string; description: string }> = {
  implementation_plan: {
    label: "Implement — plan it, review it, then build",
    description: "The council debates, a planner writes a phased plan, the panel reviews it, then it gets built.",
  },
  action_items: {
    label: "Produce action items",
    description: "Converge on a concrete, ordered list of changes to make.",
  },
  decision: { label: "Decide between options", description: "Pick one option and record why the others lose." },
  evaluation: { label: "Evaluate / review", description: "Assess what exists — strengths, failure modes, evidence." },
  investigation: { label: "Debug / investigate", description: "Find the root cause from evidence before proposing anything." },
  resolve_question: { label: "Answer a question", description: "Settle a specific question the session is stuck on." },
};

/** Union order, implementation kinds first — the deterministic option ordering. */
const KIND_ORDER: IntentKind[] = [...IMPLEMENTATION_INTENT_KINDS, ...ANALYSIS_INTENT_KINDS];

/**
 * Intent options for the launch card. `proposedKind` is the leader's own
 * `debatePlan.outputShape.kind` and leads the list; `intentSummary` is the
 * leader's one-sentence read of the topic, shown on that first option so the
 * recommendation is topic-specific rather than generic.
 */
export function buildIntentOptions(proposedKind: IntentKind, intentSummary: string): CouncilQuestionOption[] {
  const ordered = [proposedKind, ...KIND_ORDER.filter((k) => k !== proposedKind)];
  return ordered.map((kind, i) => ({
    label: i === 0 ? `${INTENT_COPY[kind].label} (recommended)` : INTENT_COPY[kind].label,
    description: i === 0 && intentSummary.trim() ? intentSummary.trim() : INTENT_COPY[kind].description,
    value: kind,
    kind: "choice" as const,
  }));
}

/**
 * Resolve the card answer. Unlike `coerceIntentKind`, junk falls back to the
 * CALLER's kind rather than to "evaluation": the leader's proposal is a better
 * default than a fixed one, and silently rewriting a build run into an analysis
 * run is the failure this whole gate exists to stop.
 */
export function parseIntentAnswer(raw: string, fallback: IntentKind): IntentKind {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const coerced = coerceIntentKind(trimmed);
  return coerced === "evaluation" && trimmed !== "evaluation" ? fallback : coerced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/intent-card.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/council/intent-card.ts src/council/__tests__/intent-card.test.ts
git commit -m "feat(council): intent options derived from the IntentKind union

Pure builder for the launch card's intent block. Options come from the union
(Record<IntentKind,...> makes a new kind a compile error) and the recommended
pick is the leader's own debatePlan.outputShape.kind, so no extra LLM call is
needed. parseIntentAnswer falls back to the leader's proposal rather than
coerceIntentKind's fixed \"evaluation\", which would silently rewrite a build
run into an analysis run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Render the intent block on the launch card and lock the answer

**Files:**
- Modify: `src/council/launch-card.ts:23-49` (input/output types), `:108-156` (`buildLaunchCard`)
- Modify: `src/council/types.ts` — add `intentKind?: IntentKind` to `ClarifiedSpec`
- Modify: `src/council/index.ts:816-878` — the launch-card call site
- Test: `src/council/__tests__/intent-card.test.ts` (extend)

**Interfaces:**
- Consumes: `buildIntentOptions`, `parseIntentAnswer` from Task 1.
- Produces: `LaunchCardInput.intent?: { proposedKind: IntentKind; intentSummary: string }`; `LaunchCard.options` leads with the intent options; `spec.intentKind` set before the debate runs.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/council/__tests__/intent-card.test.ts
import { buildLaunchCard } from "../launch-card.js";

describe("buildLaunchCard intent block", () => {
  const base = {
    topic: "add a sentinel E2E",
    leaderModelId: "leader-model",
    participants: [{ role: "implement", model: "m1" }],
    plannedRounds: 3,
    researchOn: true,
    costAware: false,
  };

  it("without an intent block the option set is unchanged", () => {
    const card = buildLaunchCard(base);
    expect(card.options.map((o) => o.value)).toEqual(["start", "cheap", "refine", "cancel"]);
  });

  it("with an intent block the intent options lead and start/cheap/refine/cancel follow", () => {
    const card = buildLaunchCard({
      ...base,
      intent: { proposedKind: "implementation_plan", intentSummary: "Build the sentinel E2E" },
    });
    expect(card.options[0].value).toBe("implementation_plan");
    const tail = card.options.slice(-4).map((o) => o.value);
    expect(tail).toEqual(["start", "cheap", "refine", "cancel"]);
    expect(card.defaultIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/intent-card.test.ts`
Expected: FAIL — the second test gets `"start"` at index 0

- [ ] **Step 3: Write minimal implementation**

In `src/council/launch-card.ts`, add to `LaunchCardInput`:

```ts
  /**
   * Intent gate (design 2026-08-04). When present, the card leads with "what do
   * you want out of this run" and the answer LOCKS spec.intentKind before any
   * spend. Absent on non-interactive paths (convenePath / sprintPlanningMode),
   * which keep the shape-only card.
   */
  intent?: { proposedKind: IntentKind; intentSummary: string };
```

with `import { buildIntentOptions } from "./intent-card.js";` and `import type { IntentKind } from "./types.js";`.

Inside `buildLaunchCard`, prepend the intent options:

```ts
  const options: CouncilQuestionOption[] = [
    ...(input.intent ? buildIntentOptions(input.intent.proposedKind, input.intent.intentSummary) : []),
    {
      label: "Start debate",
      // …unchanged…
```

and add an Intent row to `rows` when present, before `Panel`:

```ts
  if (input.intent) rows.unshift(["Intent", INTENT_COPY[input.intent.proposedKind].label]);
```

In `src/council/types.ts`, add to `ClarifiedSpec`:

```ts
  /**
   * Locked at the launch card (design 2026-08-04). Authoritative for the whole
   * run: drives outputShape, whether the planner phase runs, and the post-debate
   * transition. When absent (non-interactive paths, resumed pre-2026-08 specs)
   * callers fall back to synthesisOutputKind.
   */
  intentKind?: IntentKind;
```

In `src/council/index.ts`, at the launch-card call site (currently line 820), pass the intent block and handle the answer:

```ts
    const proposedKind = coerceIntentKind(debatePlan.outputShape.kind);
    const card = buildLaunchCard({
      topic,
      leaderModelId,
      intent: { proposedKind, intentSummary: debatePlan.intentSummary },
      // …existing fields unchanged…
    });
```

and after `const choice = (await respondToQuestion(setupQuestionId)).trim();`, before the `cancel`/`refine` branch:

```ts
    // An intent pick is not a run-shape pick: record it and keep the card's
    // shape defaults (start). Anything else falls through to the existing
    // start/cheap/refine/cancel handling untouched.
    const pickedKind = parseIntentAnswer(choice, proposedKind);
    const choseIntent = choice === pickedKind;
    spec.intentKind = pickedKind;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/intent-card.test.ts && bunx tsc --noEmit`
Expected: PASS — 7 tests; tsc reports 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/launch-card.ts src/council/types.ts src/council/index.ts src/council/__tests__/intent-card.test.ts
git commit -m "feat(council): ask what the run is for on the launch card

Session 3a8378db4adf ran a full debate (2 rounds, 284635ms) on the raw text
\"vậy làm tiếp p1 nhỉ? đã có context và plan đầy đủ chứ ?\" — a yes/no question
— because the launch card (launch-card.ts:123) only configured panel, rounds
and cost and never asked what the user wanted. The answer now locks
spec.intentKind before any spend. Non-interactive paths (convenePath,
sprintPlanningMode) pass no intent block and keep the shape-only card.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The locked kind beats the post-hoc regex

`synthesisOutputKind` (`index.ts:318-323`) regexes `"type":"…"` out of the synthesis and coerces unknowns to `"evaluation"`. In session `3a8378db4adf` that inference decided `pickPostDebateRecommendation` and `postDebateContinuation`. It becomes a fallback.

**Files:**
- Modify: `src/council/index.ts:352-355` (`synthesisIsImplementation`), `:357-400` (`postDebateContinuation`), and the `pickPostDebateRecommendation` call site
- Test: `src/council/__tests__/intent-lock.test.ts`

**Interfaces:**
- Consumes: `spec.intentKind` from Task 2.
- Produces: `resolveRunKind(locked: IntentKind | undefined, synthesis: string): IntentKind` exported from `src/council/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/intent-lock.test.ts
import { describe, expect, it } from "vitest";
import { resolveRunKind } from "../index.js";

const EVAL_SYNTHESIS = '```json\n{ "type": "evaluation", "summary": "x" }\n```';

describe("resolveRunKind", () => {
  it("the locked kind wins over the synthesis JSON", () => {
    expect(resolveRunKind("implementation_plan", EVAL_SYNTHESIS)).toBe("implementation_plan");
  });

  it("falls back to the synthesis JSON when nothing was locked", () => {
    expect(resolveRunKind(undefined, EVAL_SYNTHESIS)).toBe("evaluation");
  });

  it("falls back to evaluation when neither is available", () => {
    expect(resolveRunKind(undefined, "no json here")).toBe("evaluation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/intent-lock.test.ts`
Expected: FAIL — `resolveRunKind is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/council/index.ts`, next to `synthesisOutputKind`:

```ts
/**
 * The run's authoritative intent kind. The launch-card lock wins; the synthesis
 * JSON regex is only the fallback for runs that never saw the card
 * (convenePath, sprintPlanningMode, resumed pre-2026-08 specs).
 *
 * Before the lock existed this inference decided the whole downstream shape:
 * session 3a8378db4adf debated a yes/no question, the regex returned
 * "evaluation", and pickPostDebateRecommendation + postDebateContinuation both
 * keyed on it.
 */
export function resolveRunKind(locked: IntentKind | undefined, synthesis: string): IntentKind {
  return locked ?? synthesisOutputKind(synthesis) ?? "evaluation";
}
```

Then replace `synthesisOutputKind(synthesis)` inside `synthesisIsImplementation` and `postDebateContinuation` with `resolveRunKind(outputKind, synthesis)`, and pass `resolveRunKind(spec.intentKind, synthesisText)` into `pickPostDebateRecommendation({ …, outputKind })` at its call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/ && bunx tsc --noEmit`
Expected: PASS — the whole council suite green, tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/index.ts src/council/__tests__/intent-lock.test.ts
git commit -m "fix(council): the locked intent beats the post-hoc synthesis regex

synthesisOutputKind (index.ts:318) recovered the run's shape by regexing
\"type\":\"…\" out of the synthesis and coercing unknowns to \"evaluation\".
That inference drove pickPostDebateRecommendation and postDebateContinuation.
resolveRunKind now prefers spec.intentKind and keeps the regex only for runs
that never saw the launch card.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The PLAN.md artifact model

`ActionPlan` (`types.ts:269`) is `{ steps: [{description, agent?, priority}], estimatedComplexity, prerequisites }` — flat, no phases, no acceptance criteria, no verify command, so nothing downstream can execute P1 after P0. This task defines the phased model and its round-trip.

**Files:**
- Create: `src/council/plan-artifact.ts`
- Modify: `src/council/types.ts:269` — `ActionPlan` gains `phases`
- Test: `src/council/__tests__/plan-artifact.test.ts`

**Interfaces:**
- Produces: `interface PlanPhase { id: string; title: string; steps: string[]; files: string[]; acceptance: string[]; verify: string; done: boolean }`; `renderPlanMarkdown(topic: string, phases: PlanPhase[]): string`; `parsePlanMarkdown(body: string): PlanPhase[]`; `markPhaseDone(body: string, phaseId: string): string`; `nextPendingPhase(body: string): PlanPhase | null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/plan-artifact.test.ts
import { describe, expect, it } from "vitest";
import {
  markPhaseDone,
  nextPendingPhase,
  parsePlanMarkdown,
  type PlanPhase,
  renderPlanMarkdown,
} from "../plan-artifact.js";

const PHASES: PlanPhase[] = [
  {
    id: "P0",
    title: "Sentinel transition E2E",
    steps: ["Add the spy", "Assert the sentinel wins"],
    files: ["src/council/index.ts"],
    acceptance: ["The sentinel action reaches the caller unchanged"],
    verify: "bunx vitest run src/council/__tests__/phase-outcome-envelope.test.ts",
    done: false,
  },
  {
    id: "P1",
    title: "Canonical degraded mapping",
    steps: ["Map degraded explicitly"],
    files: ["src/council/types.ts"],
    acceptance: ["degraded no longer collapses into ask_followup"],
    verify: "bunx vitest run src/council/__tests__/",
    done: false,
  },
];

describe("plan artifact round-trip", () => {
  it("renders then parses back to the same phases", () => {
    expect(parsePlanMarkdown(renderPlanMarkdown("topic", PHASES))).toEqual(PHASES);
  });

  it("nextPendingPhase returns P0 first, then P1 once P0 is ticked", () => {
    const body = renderPlanMarkdown("topic", PHASES);
    expect(nextPendingPhase(body)?.id).toBe("P0");
    expect(nextPendingPhase(markPhaseDone(body, "P0"))?.id).toBe("P1");
  });

  it("nextPendingPhase returns null when every phase is done", () => {
    let body = renderPlanMarkdown("topic", PHASES);
    body = markPhaseDone(markPhaseDone(body, "P0"), "P1");
    expect(nextPendingPhase(body)).toBeNull();
  });

  it("markPhaseDone on an unknown id leaves the body untouched", () => {
    const body = renderPlanMarkdown("topic", PHASES);
    expect(markPhaseDone(body, "P9")).toBe(body);
  });

  it("a phase with no verify command parses to an empty string, not undefined", () => {
    const body = renderPlanMarkdown("topic", [{ ...PHASES[0], verify: "" }]);
    expect(parsePlanMarkdown(body)[0].verify).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/plan-artifact.test.ts`
Expected: FAIL — `Failed to resolve import "../plan-artifact.js"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/council/plan-artifact.ts
/**
 * `.planning/PLAN.md` as data. The planner emits this exact shape and the phase
 * executor reads it back, so the format is a contract between them — a phase
 * carries its OWN acceptance criteria and verify command, which is what lets the
 * executor gate each phase independently instead of flattening every step into
 * one prompt the way the old runExecution did.
 */

export interface PlanPhase {
  /** `P0`, `P1`, … — ordering is the array order, not the number. */
  id: string;
  title: string;
  steps: string[];
  files: string[];
  acceptance: string[];
  /** Shell command that proves this phase; empty string when the plan gives none. */
  verify: string;
  done: boolean;
}

const PHASE_RE = /^##\s+(P\d+)\s+—\s+(.+)$/;
const BULLET_RE = /^-\s+(.+)$/;

function section(lines: string[], heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith(`**${heading}:**`)) {
      inside = true;
      const inline = line.slice(`**${heading}:**`.length).trim();
      if (inline) out.push(inline);
      continue;
    }
    if (inside) {
      const m = BULLET_RE.exec(line.trim());
      if (m) {
        out.push(m[1]);
        continue;
      }
      if (line.trim()) break;
    }
  }
  return out;
}

export function renderPlanMarkdown(topic: string, phases: PlanPhase[]): string {
  const blocks = phases.map((p) =>
    [
      `## ${p.id} — ${p.title}`,
      "",
      `**Files:**`,
      ...p.files.map((f) => `- ${f}`),
      "",
      `**Steps:**`,
      ...p.steps.map((s) => `- ${s}`),
      "",
      `**Acceptance:**`,
      ...p.acceptance.map((a) => `- ${a}`),
      "",
      `**Verify:** ${p.verify}`,
      "",
      `**Status:** ${p.done ? "done" : "pending"}`,
    ].join("\n"),
  );
  return [`# PLAN — ${topic}`, "", ...blocks].join("\n\n").trimEnd() + "\n";
}

export function parsePlanMarkdown(body: string): PlanPhase[] {
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (PHASE_RE.test(line)) starts.push(i);
  });
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const block = lines.slice(start, end);
    const head = PHASE_RE.exec(block[0]);
    const statusLine = block.find((l) => l.startsWith("**Status:**")) ?? "";
    const verifyLine = block.find((l) => l.startsWith("**Verify:**")) ?? "";
    return {
      id: head?.[1] ?? "",
      title: head?.[2]?.trim() ?? "",
      steps: section(block, "Steps"),
      files: section(block, "Files"),
      acceptance: section(block, "Acceptance"),
      verify: verifyLine.slice("**Verify:**".length).trim(),
      done: statusLine.slice("**Status:**".length).trim() === "done",
    };
  });
}

export function markPhaseDone(body: string, phaseId: string): string {
  const lines = body.split(/\r?\n/);
  let inPhase = false;
  let changed = false;
  const out = lines.map((line) => {
    const head = PHASE_RE.exec(line);
    if (head) inPhase = head[1] === phaseId;
    if (inPhase && line.startsWith("**Status:**")) {
      inPhase = false;
      changed = true;
      return "**Status:** done";
    }
    return line;
  });
  return changed ? out.join("\n") : body;
}

export function nextPendingPhase(body: string): PlanPhase | null {
  return parsePlanMarkdown(body).find((p) => !p.done) ?? null;
}
```

Extend `ActionPlan` in `src/council/types.ts`:

```ts
export interface ActionPlan {
  steps: Array<{
    description: string;
    agent?: string;
    priority: "high" | "medium" | "low";
  }>;
  estimatedComplexity: "trivial" | "moderate" | "complex";
  prerequisites: string[];
  /**
   * Phased form written to `.planning/PLAN.md` (design 2026-08-04). `steps` is
   * kept for the legacy callers; the executor reads `phases` because a flat step
   * list cannot carry per-phase acceptance criteria or a per-phase verify
   * command — which is why the old flow could only ever execute one step.
   */
  phases?: import("./plan-artifact.js").PlanPhase[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/plan-artifact.test.ts && bunx tsc --noEmit`
Expected: PASS — 5 tests; tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/plan-artifact.ts src/council/types.ts src/council/__tests__/plan-artifact.test.ts
git commit -m "feat(council): phased PLAN.md artifact model

ActionPlan (types.ts:269) was a flat step list with no acceptance criteria and
no verify command, so nothing downstream could gate P0 and then continue to P1.
PlanPhase carries both per phase, and renderPlanMarkdown/parsePlanMarkdown make
the format a round-trippable contract between the planner and the executor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Planner generates the plan

**Files:**
- Create: `src/council/plan-phase.ts`
- Test: `src/council/__tests__/plan-phase.test.ts`

**Interfaces:**
- Consumes: `PlanPhase`, `renderPlanMarkdown` (Task 4); `tracedGenerate` from `src/council/llm.ts:1083`; `planningArtifact` from `src/gsd/paths.ts:38`; `phaseStart`/`phaseDone` from `src/council/phase-events.ts`.
- Produces: `buildPlannerPrompt(topic: string, synthesis: string, exchanges: string): string`; `parsePlannerPhases(raw: string): PlanPhase[]`; `runPlannerPhase(args: PlannerArgs): AsyncGenerator<StreamChunk, { planPath: string; phases: PlanPhase[] } | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/plan-phase.test.ts
import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, parsePlannerPhases } from "../plan-phase.js";

const MODEL_OUTPUT = `Here is the plan.

\`\`\`json
{
  "phases": [
    {
      "id": "P0",
      "title": "Sentinel E2E",
      "steps": ["Add the spy"],
      "files": ["src/council/index.ts"],
      "acceptance": ["Sentinel wins end to end"],
      "verify": "bunx vitest run src/council/__tests__/"
    }
  ]
}
\`\`\``;

describe("parsePlannerPhases", () => {
  it("extracts phases and defaults done to false", () => {
    const phases = parsePlannerPhases(MODEL_OUTPUT);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
    expect(phases[0].done).toBe(false);
    expect(phases[0].verify).toContain("vitest");
  });

  it("returns an empty array on unparseable output rather than throwing", () => {
    expect(parsePlannerPhases("the model rambled")).toEqual([]);
  });

  it("drops a phase with no acceptance criteria — an ungateable phase is not a phase", () => {
    const raw = '```json\n{"phases":[{"id":"P0","title":"t","steps":["s"],"files":[],"acceptance":[],"verify":""}]}\n```';
    expect(parsePlannerPhases(raw)).toEqual([]);
  });
});

describe("buildPlannerPrompt", () => {
  it("carries the synthesis and demands the phase contract", () => {
    const p = buildPlannerPrompt("topic", "SYNTHESIS-BODY", "EXCHANGES");
    expect(p).toContain("SYNTHESIS-BODY");
    expect(p).toContain("acceptance");
    expect(p).toContain("verify");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/plan-phase.test.ts`
Expected: FAIL — `Failed to resolve import "../plan-phase.js"`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/council/plan-phase.ts
import { writeFileSync } from "node:fs";
import { planningArtifact } from "../gsd/paths.js";
import type { StreamChunk } from "../types/index.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import { extractJsonObject } from "./planner.js";
import { type PlanPhase, renderPlanMarkdown } from "./plan-artifact.js";
import type { CouncilLLM } from "./types.js";

export function buildPlannerPrompt(topic: string, synthesis: string, exchanges: string): string {
  return [
    `You are the council PLANNER. The debate on "${topic}" has concluded.`,
    "",
    "Approved conclusion:",
    synthesis,
    "",
    "Debate exchanges (for grounding — do NOT re-litigate them):",
    exchanges.slice(0, 12_000),
    "",
    "Write the implementation plan as ORDERED PHASES. Every phase must be independently",
    "gateable: it carries its own acceptance criteria and its own verify command.",
    "Do not fold the whole change into one phase, and do not invent scope the",
    "conclusion did not agree to.",
    "",
    "Emit ONE fenced json block and nothing else after it:",
    '```json',
    '{ "phases": [ { "id": "P0", "title": "…", "steps": ["…"], "files": ["…"],',
    '               "acceptance": ["…"], "verify": "<shell command, or empty string>" } ] }',
    '```',
  ].join("\n");
}

/**
 * Phases from planner output. A phase with no acceptance criteria is DROPPED:
 * the executor gates each phase on its criteria, so an empty-criteria phase
 * would auto-pass and reintroduce exactly the unverified "implement" the plan
 * gate exists to stop.
 */
export function parsePlannerPhases(raw: string): PlanPhase[] {
  const { json } = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.error(`[council/plan-phase] planner JSON parse failed: ${(err as Error).message}`);
    return [];
  }
  const rows = (parsed as { phases?: unknown })?.phases;
  if (!Array.isArray(rows)) return [];
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return rows
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: typeof row.id === "string" ? row.id : "",
        title: typeof row.title === "string" ? row.title : "",
        steps: asStrings(row.steps),
        files: asStrings(row.files),
        acceptance: asStrings(row.acceptance),
        verify: typeof row.verify === "string" ? row.verify : "",
        done: false,
      } satisfies PlanPhase;
    })
    .filter((p) => p.id && p.title && p.acceptance.length > 0);
}

export interface PlannerArgs {
  cwd: string;
  topic: string;
  synthesis: string;
  exchanges: string;
  plannerModelId: string;
  llm: CouncilLLM;
  signal?: AbortSignal;
}

export async function* runPlannerPhase(
  args: PlannerArgs,
): AsyncGenerator<StreamChunk, { planPath: string; phases: PlanPhase[] } | null, unknown> {
  yield phaseStart({ phaseId: "phase:plan", kind: "planning", label: "Planner — drafting the plan" });
  let raw = "";
  try {
    raw = yield* tracedGenerate(args.llm, {
      modelId: args.plannerModelId,
      phase: "planning",
      label: "Planner",
      system: "You write phased, independently-verifiable implementation plans.",
      prompt: buildPlannerPrompt(args.topic, args.synthesis, args.exchanges),
      signal: args.signal,
    });
  } catch (err) {
    console.error(`[council/plan-phase] planner generate failed: ${(err as Error).message}`);
    yield phaseError({ phaseId: "phase:plan", kind: "planning", label: "Planner failed" });
    return null;
  }
  const phases = parsePlannerPhases(raw);
  if (phases.length === 0) {
    console.error("[council/plan-phase] planner emitted no gateable phase — plan not written");
    yield phaseError({ phaseId: "phase:plan", kind: "planning", label: "Planner produced no gateable phase" });
    return null;
  }
  const planPath = planningArtifact(args.cwd, "PLAN.md");
  writeFileSync(planPath, renderPlanMarkdown(args.topic, phases), "utf8");
  yield phaseDone({ phaseId: "phase:plan", kind: "planning", label: `Plan drafted — ${phases.length} phase(s)` });
  return { planPath, phases };
}
```

Import `phaseError` alongside `phaseDone`/`phaseStart` from `./phase-events.js`; check its exact signature there and match it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/plan-phase.test.ts && bunx tsc --noEmit`
Expected: PASS — 4 tests; tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/plan-phase.ts src/council/__tests__/plan-phase.test.ts
git commit -m "feat(council): planner phase writes a phased .planning/PLAN.md

A council with no planner produced its next step from the synthesis'
single recommendation field, so continuing past it needed a whole new debate
(session 3a8378db4adf). The planner turns the approved conclusion into ordered
phases, each with its own acceptance criteria and verify command. A phase with
no acceptance criteria is dropped rather than written — it would auto-pass the
executor gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Panelists cross-review the plan, leader merges

The GSD plan-review machinery already exists (`src/gsd/plan-council.ts:188`) but its reviewers are the fixed `PlanPerspectiveId` union with no debate context. This task reviews with the debate participants and reuses `extractStructuredVerdict` + `setStateField`.

**Files:**
- Modify: `src/council/plan-phase.ts` — add the review stage
- Test: `src/council/__tests__/plan-phase.test.ts` (extend)

**Interfaces:**
- Consumes: `extractStructuredVerdict`, `VERDICT_OUTPUT_CONTRACT` from `src/gsd/verdict-schema.ts:107,137`; `setStateField` from `src/gsd/workflow-engine.ts:161`; `getPlanReviewDebateRetries` from `src/gsd/flags.ts:172`.
- Produces: `mergeReviewVerdicts(results: Array<{ role: string; verdict: PerspectiveVerdict; concerns: string[] }>): { verdict: PerspectiveVerdict; concerns: string[] }`; `runPlanReview(args: ReviewArgs): AsyncGenerator<StreamChunk, PlanReviewOutcome>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/council/__tests__/plan-phase.test.ts
import { mergeReviewVerdicts } from "../plan-phase.js";

describe("mergeReviewVerdicts", () => {
  it("any block blocks, and its concerns survive", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "block", concerns: ["unsafe migration"] },
    ]);
    expect(m.verdict).toBe("block");
    expect(m.concerns).toContain("unsafe migration");
  });

  it("any revise (absent a block) means revise", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "revise", concerns: ["no rollback"] },
    ]);
    expect(m.verdict).toBe("revise");
  });

  it("unanimous approve approves", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "approve", concerns: [] },
    ]);
    expect(m.verdict).toBe("approve");
    expect(m.concerns).toEqual([]);
  });

  it("no reviewers is a revise, never a silent approve", () => {
    expect(mergeReviewVerdicts([]).verdict).toBe("revise");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/plan-phase.test.ts`
Expected: FAIL — `mergeReviewVerdicts is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/council/plan-phase.ts`:

```ts
import { writeFileSync } from "node:fs";
import { getPlanReviewDebateRetries } from "../gsd/flags.js";
import { extractStructuredVerdict, VERDICT_OUTPUT_CONTRACT } from "../gsd/verdict-schema.js";
import { setStateField } from "../gsd/workflow-engine.js";
import type { PerspectiveVerdict } from "../gsd/plan-council.js";
import type { CouncilParticipant } from "./types.js";

export interface PlanReviewOutcome {
  verdict: PerspectiveVerdict;
  concerns: string[];
  reviewPath: string;
  planVerified: boolean;
}

/**
 * Severity wins, and an EMPTY reviewer set is a `revise`, never an approve —
 * a plan nobody reviewed must not clear the gate just because no dissent was
 * recorded. Mirrors plan-council.ts's conservative parse-failure handling.
 */
export function mergeReviewVerdicts(
  results: Array<{ role: string; verdict: PerspectiveVerdict; concerns: string[] }>,
): { verdict: PerspectiveVerdict; concerns: string[] } {
  if (results.length === 0) return { verdict: "revise", concerns: ["No reviewer produced a verdict."] };
  const concerns = results.flatMap((r) => r.concerns);
  if (results.some((r) => r.verdict === "block")) return { verdict: "block", concerns };
  if (results.some((r) => r.verdict === "revise")) return { verdict: "revise", concerns };
  return { verdict: "approve", concerns };
}

export function buildReviewPrompt(planBody: string, stanceName: string, lens: string): string {
  return [
    `You reviewed this topic in the debate as "${stanceName}" (${lens}).`,
    "Review the plan below through that same lens. You already hold the debate context —",
    "judge whether the plan actually delivers what the council agreed, whether each phase",
    "is independently verifiable, and whether anything was smuggled in that was not agreed.",
    "",
    "--- PLAN.md ---",
    planBody,
    "--- end PLAN.md ---",
    "",
    ...VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
```

`runPlanReview` runs `buildReviewPrompt` through `tracedGenerate` once per participant (sequentially, matching how the debate phases already serialize), parses each with `extractStructuredVerdict` (null → `revise` with the "did not emit a structured verdict" concern, per `plan-council.ts:260`), merges with `mergeReviewVerdicts`, writes `PLAN-REVIEW.md` via `planningArtifact(cwd, "PLAN-REVIEW.md")`, and on `approve` calls `setStateField(cwd, "Plan Verified", "yes")`. On `revise` it re-enters the planner with the merged concerns appended to the planner prompt, bounded by `getPlanReviewDebateRetries()`. Every `catch` logs `[council/plan-phase]` + the reviewer's stance name + `err.message`.

Confirm the exact `STATE.md` field name `setStateField` expects by reading `src/gsd/workflow-engine.ts:161-198` before writing this line — `readState` parses `planVerified` at `:157`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/plan-phase.test.ts && bunx tsc --noEmit`
Expected: PASS — 8 tests; tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/plan-phase.ts src/council/__tests__/plan-phase.test.ts
git commit -m "feat(council): debate panelists cross-review the plan, leader merges

src/gsd/plan-council.ts already reviews PLAN.md with structured verdicts and
sets planVerified, but its reviewers are the fixed PlanPerspectiveId union with
no debate context — a shape check, not a deep review. The reviewers are now the
panelists who just argued the topic, reusing extractStructuredVerdict and
setStateField. An empty reviewer set merges to revise, never a silent approve.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Post-plan card, and remove the generate_plan alias

`generate_plan` and `implement` return the identical string (`index.ts:369`), so `generate_plan` is a no-op alias. It becomes the real trigger for the planner phase, and the post-debate card for implementation-shape runs is replaced by a card that reports the plan path.

**Files:**
- Modify: `src/council/index.ts:357-400` (`postDebateContinuation`), `:1233-1241` and `:1296-1307` (option construction), `:1632` (the `generate_plan` branch)
- Test: `src/council/__tests__/post-plan-card.test.ts`

**Interfaces:**
- Consumes: `PlanReviewOutcome` (Task 6), `resolveRunKind` (Task 3).
- Produces: `buildPostPlanCard(input: { planPath: string; phases: PlanPhase[]; verdict: PerspectiveVerdict; concerns: string[] }): { question: string; context: string; options: CouncilQuestionOption[]; defaultIndex: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/post-plan-card.test.ts
import { describe, expect, it } from "vitest";
import { buildPostPlanCard } from "../index.js";
import type { PlanPhase } from "../plan-artifact.js";

const PHASES: PlanPhase[] = [
  { id: "P0", title: "a", steps: [], files: [], acceptance: ["x"], verify: "", done: false },
  { id: "P1", title: "b", steps: [], files: [], acceptance: ["y"], verify: "", done: false },
];

describe("buildPostPlanCard", () => {
  it("reports the plan path and every phase", () => {
    const card = buildPostPlanCard({ planPath: ".planning/PLAN.md", phases: PHASES, verdict: "approve", concerns: [] });
    expect(card.context).toContain(".planning/PLAN.md");
    expect(card.context).toContain("P0");
    expect(card.context).toContain("P1");
  });

  it("an approved plan defaults to executing the whole plan", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "approve", concerns: [] });
    expect(card.options[card.defaultIndex].value).toBe("execute_plan");
  });

  it("a blocked plan offers no execute option and surfaces the concerns", () => {
    const card = buildPostPlanCard({ planPath: "p", phases: PHASES, verdict: "block", concerns: ["unsafe"] });
    expect(card.options.some((o) => o.value === "execute_plan")).toBe(false);
    expect(card.context).toContain("unsafe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/post-plan-card.test.ts`
Expected: FAIL — `buildPostPlanCard is not a function`

- [ ] **Step 3: Write minimal implementation**

Add `buildPostPlanCard` to `src/council/index.ts`. Options: `execute_plan` (omitted when the verdict is `block`), `revise_plan` (`kind: "freetext"` — the user's comments re-enter the planner), `save_exit`. `defaultIndex` points at `execute_plan` when present, otherwise `revise_plan`. The `context` lists the plan path, one line per phase (`P0 — title · N acceptance criteria`), the verdict, and every concern.

In the same file, delete the `generate_plan` arm of `postDebateContinuation` (`index.ts:369`) so `implement` is the only build action, and reverse the comment at `index.ts:366-368`:

```ts
  // IMPLEMENT — carry the REVIEWED PLAN, not the synthesis. The previous design
  // (see git history for this comment) treated the synthesis as a sufficient
  // spec and fed it back as prose; PIL then classified that prose as
  // taskType=analyze / deliverable=report (session 3a8378db4adf, interaction_logs
  // id 2498) and the "implement" turn ran as a report against
  // planVerified:false. Execution now goes through the marked envelope in
  // plan-execution.ts. See docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md.
```

Remove the `generate_plan` option construction at `:1233-1241` and its answer branch at `:1632`, and keep `PostDebateActionId`'s member only if another caller still references it — run `rg -n "generate_plan" src/` and delete the member plus its now-dead tests if nothing does.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/ && bunx tsc --noEmit`
Expected: PASS — council suite green; tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/index.ts src/council/__tests__/post-plan-card.test.ts
git commit -m "feat(council): post-plan card reports the plan path; drop the generate_plan alias

generate_plan returned the identical continuation string to implement
(index.ts:369), so it was a no-op alias. Implementation-shape runs now end on a
card that reports .planning/PLAN.md, its phases, the leader verdict and the
reviewer concerns, with execute_plan offered only when the verdict is not
block. The 2026-07 comment claiming a synthesis is a sufficient spec is
reversed in place with the evidence that disproved it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Marked execution envelope and the per-phase loop

The measured defect: the prose continuation is classified `taskType=analyze, deliverable=report` (`interaction_logs` id 2498). `src/pil/pipeline.ts:167-177` already fixes exactly this for `/ideal` via `SPRINT_EXECUTION_MARKER`. The council gets its own marker, and `runExecution`'s flatten-everything-into-one-prompt is replaced by a gated loop.

**Files:**
- Create: `src/council/plan-execution.ts`
- Modify: `src/pil/layer6-output.ts:321-332`, `src/pil/pipeline.ts:167`
- Delete: `src/council/executor.ts` (and its import in `src/council/index.ts`)
- Test: `src/council/__tests__/plan-execution.test.ts`

**Interfaces:**
- Consumes: `PlanPhase`, `parsePlanMarkdown`, `markPhaseDone`, `nextPendingPhase` (Task 4).
- Produces: `COUNCIL_PLAN_EXECUTION_MARKER: string` and `isCouncilPlanExecution(raw: string): boolean` in `src/pil/layer6-output.ts`; `buildPhasePrompt(planPath: string, phase: PlanPhase): string`; `verifyPhase(phase: PlanPhase, cwd: string, exec?: ExecFn): { ok: boolean; output: string }`; `runPlanExecution(args: ExecutionArgs): AsyncGenerator<StreamChunk, { completed: string[]; haltedAt: string | null; reason: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/council/__tests__/plan-execution.test.ts
import { describe, expect, it } from "vitest";
import { isCouncilPlanExecution, isImplementationIntent } from "../../pil/layer6-output.js";
import { buildPhasePrompt, verifyPhase } from "../plan-execution.js";
import type { PlanPhase } from "../plan-artifact.js";

const PHASE: PlanPhase = {
  id: "P0",
  title: "Sentinel E2E",
  steps: ["Add the spy"],
  files: ["src/council/index.ts"],
  acceptance: ["Sentinel wins end to end"],
  verify: "bunx vitest run x",
  done: false,
};

describe("execution envelope", () => {
  it("a phase prompt is recognised as council plan execution", () => {
    expect(isCouncilPlanExecution(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("a phase prompt also reads as implementation intent", () => {
    expect(isImplementationIntent(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("ordinary prose is not council plan execution", () => {
    expect(isCouncilPlanExecution("Council debate completed. Approved conclusion: …")).toBe(false);
  });

  it("the prompt carries the phase acceptance criteria and its verify command", () => {
    const p = buildPhasePrompt(".planning/PLAN.md", PHASE);
    expect(p).toContain("Sentinel wins end to end");
    expect(p).toContain("bunx vitest run x");
    expect(p).toContain("P0");
  });
});

describe("verifyPhase", () => {
  it("a zero exit status passes", () => {
    const r = verifyPhase(PHASE, "/tmp", () => ({ stdout: "ok", stderr: "", status: 0 }));
    expect(r.ok).toBe(true);
  });

  it("a non-zero exit status fails and keeps the output for the halt reason", () => {
    const r = verifyPhase(PHASE, "/tmp", () => ({ stdout: "", stderr: "2 failed", status: 1 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("2 failed");
  });

  it("a phase with no verify command does NOT auto-pass", () => {
    const r = verifyPhase({ ...PHASE, verify: "" }, "/tmp", () => ({ stdout: "", stderr: "", status: 0 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no verify command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/plan-execution.test.ts`
Expected: FAIL — `Failed to resolve import "../plan-execution.js"`

- [ ] **Step 3: Write minimal implementation**

In `src/pil/layer6-output.ts`, beside `SPRINT_EXECUTION_MARKER` (`:321`):

```ts
/**
 * Council plan execution (design 2026-08-04). Kept DISTINCT from
 * SPRINT_EXECUTION_MARKER so council and /ideal stay separable in telemetry,
 * while both hit the same pipeline branch.
 */
export const COUNCIL_PLAN_EXECUTION_MARKER = "[COUNCIL-PLAN-EXECUTION: locked]";

export function isCouncilPlanExecution(raw: string): boolean {
  return raw.includes(COUNCIL_PLAN_EXECUTION_MARKER);
}
```

and add the literal to `IMPLEMENTATION_INTENT_RE` (`:328`) alongside the existing `\[SPRINT-PLAN-EXECUTION:\s*locked\]` alternative:

```
|\[COUNCIL-PLAN-EXECUTION:\s*locked\]
```

In `src/pil/pipeline.ts:167`:

```ts
  const sprintPlanExecution = isSprintPlanExecution(ctx.raw) || isCouncilPlanExecution(ctx.raw);
```

with `isCouncilPlanExecution` added to the existing import on `:31`.

```ts
// src/council/plan-execution.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { COUNCIL_PLAN_EXECUTION_MARKER } from "../pil/layer6-output.js";
import type { StreamChunk } from "../types/index.js";
import { markPhaseDone, nextPendingPhase, type PlanPhase } from "./plan-artifact.js";

export type ExecFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => {
  stdout: string;
  stderr: string;
  status: number | null;
};

const VERIFY_TIMEOUT_MS = 600_000;

/** Mirrors the injectable-exec pattern in src/scaffold/bb-quality-gate.ts:39. */
function defaultExec(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", shell: true });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

export function buildPhasePrompt(planPath: string, phase: PlanPhase): string {
  return [
    COUNCIL_PLAN_EXECUTION_MARKER,
    "",
    `Execute phase ${phase.id} — ${phase.title} — from the approved plan at \`${planPath}\`.`,
    "This phase only. Do not start a later phase and do not re-plan.",
    "",
    "Steps:",
    ...phase.steps.map((s) => `- ${s}`),
    "",
    phase.files.length ? `Files: ${phase.files.join(", ")}` : "",
    "",
    "Acceptance criteria this phase is gated on:",
    ...phase.acceptance.map((a) => `- ${a}`),
    "",
    phase.verify ? `Verify with: ${phase.verify}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Deterministic phase gate. A phase with NO verify command fails rather than
 * passing: an unverifiable phase silently ticking itself green is precisely the
 * shallow "implemented" the plan gate exists to prevent. The planner is required
 * to supply one (parsePlannerPhases drops criteria-less phases), so an empty
 * command here means the plan was hand-edited.
 */
export function verifyPhase(phase: PlanPhase, cwd: string, exec: ExecFn = defaultExec): { ok: boolean; output: string } {
  if (!phase.verify.trim()) {
    return { ok: false, output: `[${phase.id}] no verify command in the plan — cannot gate this phase` };
  }
  try {
    const r = exec(phase.verify, [], cwd, VERIFY_TIMEOUT_MS);
    const output = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: r.status === 0, output };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[council/plan-execution] verify threw for ${phase.id}: ${message}`);
    return { ok: false, output: message };
  }
}

export interface ExecutionArgs {
  cwd: string;
  planPath: string;
  processMessage: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  exec?: ExecFn;
}

export async function* runPlanExecution(
  args: ExecutionArgs,
): AsyncGenerator<StreamChunk, { completed: string[]; haltedAt: string | null; reason: string }, unknown> {
  const completed: string[] = [];
  for (;;) {
    const body = readFileSync(args.planPath, "utf8");
    const phase = nextPendingPhase(body);
    if (!phase) return { completed, haltedAt: null, reason: "plan complete" };

    yield { type: "content", content: `\n## ${phase.id} — ${phase.title}\n` };
    yield* args.processMessage(buildPhasePrompt(args.planPath, phase));

    const result = verifyPhase(phase, args.cwd, args.exec);
    if (!result.ok) {
      yield { type: "content", content: `\n> Halted at ${phase.id}: verify failed.\n\n${result.output.slice(0, 2000)}\n` };
      return { completed, haltedAt: phase.id, reason: result.output };
    }
    writeFileSync(args.planPath, markPhaseDone(body, phase.id), "utf8");
    completed.push(phase.id);
  }
}
```

Delete `src/council/executor.ts` and replace **all three** of its touch points in `src/council/index.ts` — the import at `:26`, the Phase E call `yield* runExecution(plan, processMessageFn)` at `:1921`, and the "clear plan so Phase E's runExecution guard does not fire" logic at `:1698-1700`, which exists only to suppress that call and becomes dead once it is gone. Read `:1630-1640` and `:1690-1705` before editing: the comments there record why the post-debate branch already stopped calling `runExecution`, and the Phase E call is the one that still runs. Wire the `execute_plan` answer from Task 7's card to `runPlanExecution` at the Phase E site.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/plan-execution.test.ts src/pil/__tests__/ && bunx tsc --noEmit`
Expected: PASS — 7 new tests; PIL suite still green; tsc 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/council/plan-execution.ts src/pil/layer6-output.ts src/pil/pipeline.ts src/council/index.ts src/council/__tests__/plan-execution.test.ts
git rm src/council/executor.ts
git commit -m "feat(council): marked execution envelope and a gated per-phase loop

The prose continuation was classified taskType=analyze, deliverable=report
(interaction_logs id 2498, session 3a8378db4adf) and the implement turn ran as
a report against planVerified:false. pipeline.ts:167 already forces
directAnswer:false / deliverableKind:\"code\" for SPRINT_EXECUTION_MARKER; the
council now carries its own marker into the same branch.

runExecution flattened every step into one prompt with no gate, which is why
only the first step ever landed. runPlanExecution runs one phase per turn,
verifies with that phase's own command, ticks PLAN.md on pass and HALTS on
fail. A phase with no verify command fails rather than auto-passing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Harness E2E

Per `CLAUDE.md`, council specs must spawn in a **fresh greenfield temp cwd** — spawning in the repo root makes the discover phase scan muonroi-cli and race the timeout (the misattribution documented in caveat 2).

**Files:**
- Create: `tests/harness/council-plan-gate.spec.ts`
- Create: `tests/harness/fixtures/llm/council-plan-gate.json`

**Interfaces:**
- Consumes: `spawnHarness` from `tests/harness/helpers.ts`; the driver API in `CLAUDE.md` → "Driver API cheat sheet".

- [ ] **Step 1: Write the failing spec**

```ts
// tests/harness/council-plan-gate.spec.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("council intent gate + plan card", () => {
  let h: Awaited<ReturnType<typeof spawnHarness>>;
  const cwd = mkdtempSync(join(tmpdir(), "council-plan-gate-"));

  beforeAll(async () => {
    h = await spawnHarness({ cwd, fixtures: "council-plan-gate" });
  }, 120_000);

  afterAll(() => h?.stop());

  it("the launch card leads with the intent options", async () => {
    h.driver.type("/council add a sentinel transition E2E");
    h.driver.press("Enter");
    await h.driver.wait_for({ event: "askcard-open", timeoutMs: 60_000 });
    const e = h.driver.last_event("askcard-open");
    expect(e?.phase).toBe("council-setup");
    // 4 shape options + 6 IntentKind options. The askcard-open LiveEvent
    // carries optionCount but NOT the labels (protocol.ts:221-230) — the DB
    // row has optionLabels, the event does not. Read the labels off the
    // rendered card instead of inventing a protocol field.
    expect(e?.optionCount).toBe(10);
    const card = h.driver.render_text();
    expect(card).toMatch(/implement/i);
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/council-plan-gate.spec.ts`
Expected: FAIL — the first option is `Start debate`, not an intent option

- [ ] **Step 3: Confirm the implementation from Tasks 1–8 satisfies it**

No new production code. If the spec fails for a reason other than the assertion (fixture shape, timeout), fix the fixture — `createMockModel` needs a `generate` field for the debate-planner's `generateObject`, per `CLAUDE.md` caveat 2.

- [ ] **Step 4: Run the spec to verify it passes**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/council-plan-gate.spec.ts`
Expected: PASS

- [ ] **Step 5: Full gate, then commit**

```bash
bunx tsc --noEmit
bunx vitest run
bunx vitest -c vitest.harness.config.ts run tests/harness/
bun run lint:semantic && bun run lint:harness-skips
git add tests/harness/council-plan-gate.spec.ts tests/harness/fixtures/llm/council-plan-gate.json
git commit -m "test(harness): E2E for the council intent gate

Spawns in a fresh temp cwd per the council-spec convention (CLAUDE.md caveat 2)
so the discover phase does not scan muonroi-cli and race the timeout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| D1 intent gate merged into launch card | 1, 2 |
| D1 locked kind replaces `synthesisOutputKind` | 3 |
| D2 planner writes `.planning/PLAN.md` | 4, 5 |
| D2 panelists cross-review, leader merges, `planVerified` | 6 |
| D3 post-plan card | 7 |
| D4 marked envelope + per-phase verify + halt | 8 |
| D5 remove the `generate_plan` alias, reverse the comment | 7 |
| Testing: 6 unit areas + 3 harness assertions | 1–9 |

**Type consistency:** `PlanPhase` is defined once in Task 4 and imported by Tasks 5, 7, 8. `PerspectiveVerdict` is imported from `src/gsd/plan-council.ts:18` rather than redeclared. `IntentKind` comes from `src/council/types.ts:294` throughout. `ExecFn` matches the `exec` signature at `src/scaffold/bb-quality-gate.ts:39`.

**Known gap to resolve during Task 6:** the exact `STATE.md` field name `setStateField(cwd, field, value)` writes for plan verification is not pinned in this plan. Read `src/gsd/workflow-engine.ts:161-198` and `:157` (where `readState` parses `planVerified`) and use the name that round-trips — do not guess it.

**Harness E2E scope:** Task 9 asserts the intent gate only. The post-plan card and the phase loop are covered by unit tests (Tasks 7, 8); extending the spec to drive a full debate through a mock panel is worthwhile but is a separate task, not a silent omission.

---

### Task 10: Make the intent gate reachable from `/council`

Added after Task 9 surfaced that the feature is unreachable by the most obvious route. Verified by the controller: `src/ui/use-app-logic.tsx:5323` dispatches the slash command as `agent.runCouncilV2(topic, { convenePath: true })` (commit `56b39a0b`, predating this branch), and the launch card is gated on `!options?.convenePath` — so typing `/council <topic>` has never shown the launch card at all, neither the new intent block nor the pre-existing panel / rounds / cost configurator. The only interactive path that shows it is auto-council, which `src/orchestrator/tool-engine.ts:834-850` deliberately runs WITHOUT `convenePath` for exactly this reason.

**The distinction to encode.** `convenePath` currently conflates two unrelated suppressions:

1. *post-debate* — the CLI must not hardcode what happens after the debate; the agent that convened it decides. This is the flag's real purpose and must be preserved everywhere it applies today.
2. *pre-debate* — the launch card, which asks the user what the run is for and what it may spend, BEFORE any money is spent.

On the `/council` slash path a human just typed the command, so there is someone present to answer (2). On the genuinely agent-convened paths — the `convene_council` tool and the `runDebate` builtin — there is no human turn, and both suppressions must stay.

**Files:**
- Modify: `src/council/index.ts` — the launch-card gate and the options type
- Modify: `src/ui/use-app-logic.tsx:5323` — the slash dispatch
- Modify: whichever option types thread it (`src/orchestrator/message-processor.ts` and the `runCouncilV2` signature — locate them; do not assume line numbers, they have drifted)
- Test: `src/council/__tests__/` — extend an existing council test file rather than adding a new one if a natural home exists

**Interfaces:**
- Consumes: the existing `convenePath` option and the launch-card gate `sessionId && !options?.convenePath && !options?.sprintPlanningMode && !userAborted()`.
- Produces: a new option on `RunCouncilOptions` that permits the pre-debate card while leaving post-debate suppression intact.

- [ ] **Step 1: Write the failing tests**

Three cases, in whichever existing council test file is the natural home:
- the slash-path shape (convenePath + the new flag) EMITS a `council-setup` `council_question` chunk;
- the agent-convened shape (convenePath alone) emits NONE;
- the slash-path shape still emits NO `post-debate` card — the existing `convene-path.test.ts` invariant must not regress.

- [ ] **Step 2: Run them and confirm they fail for the stated reason**

Run: `bunx vitest run src/council/__tests__/`
Expected: the first case FAILS because the gate suppresses the card whenever `convenePath` is set.

- [ ] **Step 3: Implement**

Add the option, widen only the launch-card gate to honour it, and pass it from the slash dispatch. Do NOT change `convenePath`'s effect on the post-debate card, on the neutral continuation, or on `autoApprovePreflight` — the blast radius is the launch card and nothing else.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bunx vitest run src/council/__tests__/` then the FULL `bunx vitest run`
Expected: all green, `convene-path.test.ts` still passing unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(council): let /council show the pre-debate card it never showed

Typing /council <topic> dispatched runCouncilV2 with convenePath:true
(use-app-logic.tsx:5323, commit 56b39a0b), and the launch card is gated on
!convenePath — so the slash command never showed the launch card at all,
neither the intent block nor the pre-existing panel/rounds/cost configurator.
The only path that showed it was auto-council.

convenePath conflated two suppressions: the CLI must not hardcode the
POST-debate decision when an agent convened the run, and the PRE-debate card.
Only the first is what the flag exists for. A human who just typed /council is
present to answer the second.

Post-debate suppression, the neutral continuation and autoApprovePreflight are
unchanged on every path; convene_council and the runDebate builtin still
suppress both.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
