# GSD Hard-Gate Backbone + Council-Verified Verify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GSD the enforced reliability backbone: a hard runtime gate blocks `edit_file`/`write_file`/`bash` on heavy tasks until `discuss→plan→plan-review` completes, and the `verify` phase gains an independent council adjudication layer on top of the deterministic test floor.

**Architecture:** Two cohesive threads. (1) **Hard gate** — a pure `evaluateMutationGate(cwd, tier, toolName)` reads GSD phase state (`readState` + `readPlanVerifyVerdict`) and is injected at the existing turn-scoped write-mutex wrapper in `tool-engine.ts`; it returns a directive ToolResult (never throws) so the model self-corrects. Auto-route is fixed so implementation-intent tasks actually enter GSD. (2) **Verify-council** — mirrors the proven `runPlanCouncil` machinery (`extractStructuredVerdict`, `verdict-schema`, `resolvePlanCouncilLeader`, debate via `runCouncilV2`) with a verify-specific context bundle (plan bundle + git diff + VERIFY.md evidence) and a verify-specific perspective set. Deterministic tests remain the gating floor; council only adjudicates goal-achievement when the floor passes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `ai` SDK `dynamicTool`, Zod v4, Vitest (`bunx vitest run`) + harness config (`vitest.harness.config.ts`), MCP harness for E2E.

## Global Constraints

- **Zero Hardcode Rule:** no model/provider ID or price string literals in production code — resolve via `catalog.json` / `getModelInfo` / settings; throw if unresolvable. Model tier for council leader comes from `resolvePlanCouncilLeader` only.
- **No Silent Catch Rule:** every `catch` logs module + operation + `err.message`. Namespace from `LogNamespace` union: `cli|ui|orchestrator|storage|ee|mcp|pil|router` — there is **no** `gsd` or `council` namespace; use `console.error("[gsd] …")` (the GSD modules already use bare `console.error` with a `[gsd]` prefix — match that, do NOT invent a logger namespace).
- **Core/UI separation:** `src/gsd/**`, `src/pil/**`, `src/orchestrator/**` may import `src/state` but MUST NOT import `src/ui` or `opentui/react`.
- **Pre-Push Test Gate:** full `bunx vitest run` = 0 failures before any push. Harness E2E via `bunx vitest -c vitest.harness.config.ts run tests/harness/`.
- **Verify mutating changes in a throwaway temp git repo**, never the repo root.
- **Reply Vietnamese, reason English; code/comments/commits/PRs English.**
- Commit trailers MUST end with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CuJVuD6u5ybAFmyJarL4pQ
  ```
- Gate default: **opt-in-safe** — a clean checkout with no `.planning/` behaves identically to today for non-heavy tasks. The gate only arms on `depthTier === "heavy"`.

---

## File Structure

**New files:**
- `src/gsd/mutation-gate.ts` — pure `evaluateMutationGate()` + `MutationGateDecision`. No I/O beyond the synchronous `readState`/`readPlanVerifyVerdict` it calls.
- `src/gsd/__tests__/mutation-gate.test.ts`
- `src/gsd/verify-council.ts` — `runVerifyCouncil()` (mirror of `runPlanCouncil`).
- `src/gsd/verify-council-prompts.ts` — verify perspectives + prompt builders.
- `src/gsd/verify-context.ts` — `buildVerifyContextBundle()` (extends council-context with diff + evidence).
- `src/gsd/__tests__/verify-council.test.ts`
- `src/gsd/__tests__/verify-context.test.ts`
- `tests/harness/gsd-hard-gate.spec.ts` — E2E.

**Modified files:**
- `src/pil/types.ts` — add `gsdGateBlocking?: boolean | null` to `PipelineContext`.
- `src/pil/layer4-gsd.ts:144-148` (mis-gate fix), `:164-171` (heavy directive), `:187-191` (propagate `gsdGateBlocking`).
- `src/pil/__tests__/layer4-gsd.test.ts` — new cases.
- `src/gsd/flags.ts` — add `isGsdHardGateEnabled()`.
- `src/orchestrator/tool-engine.ts` — inject gate at the write-mutex wrapper (~`:1042-1077`); resolve auto-council↔GSD ordering (~`:626,638-642,695-701`).
- `src/gsd/workflow-tools.ts:169-205` (`gsd_verify`) — wire Layer-2 verify-council after the deterministic floor.
- `src/gsd/index.ts` — export new public surface.
- `CLAUDE.md` — document the gate contract + env flags.

---

## Interfaces (cross-task contract — copy signatures verbatim)

```ts
// src/gsd/mutation-gate.ts
export interface MutationGateDecision {
  blocked: boolean;
  /** Directive shown to the model as a ToolResult when blocked. Empty when allowed. */
  reason: string;
}
export function evaluateMutationGate(
  cwd: string,
  opts: { tier: string; toolName: string; hardGateEnabled: boolean; directAnswer?: boolean },
): MutationGateDecision;

// src/gsd/flags.ts
export function isGsdHardGateEnabled(): boolean;

// src/gsd/verify-context.ts
export interface VerifyContextBundle {
  base: import("./council-context.js").CouncilContextBundle;
  diff: string;
  diffChars: number;
  evidence: string;
  planVerdict: "pass" | "revise" | "block" | null;
}
export function buildVerifyContextBundle(
  cwd: string,
  opts: { depth: string; evidence?: string; diff?: string },
): VerifyContextBundle;

// src/gsd/verify-council-prompts.ts
export type VerifyPerspectiveId = "acceptance" | "correctness" | "regression" | "security";
export interface VerifyPerspective { id: VerifyPerspectiveId; role: string; mandate: string; }
export function verifyPerspectivesForDepth(depth: string): VerifyPerspective[];
export function buildVerifyPerspectivePrompt(p: VerifyPerspective, b: VerifyContextBundle): string;
export function buildVerifyDebateTopic(b: VerifyContextBundle): string;

// src/gsd/verify-council.ts
export interface VerifyCouncilResult {
  skipped: boolean;
  verdict: "pass" | "revise" | "block";
  concerns: string[];
  verifyCouncilPath?: string;
  leaderModelId?: string;
  verdictSource: "structured" | "heuristic-fallback" | "parse-failed";
}
export function runVerifyCouncil(opts: {
  cwd: string;
  sessionModelId: string;
  depth: string;
  evidence?: string;
  runPerspectiveFn?: (prompt: string, p: import("./verify-council-prompts.js").VerifyPerspective) => Promise<string>;
  runDebate?: (topic: string) => Promise<string>;
}): Promise<VerifyCouncilResult>;
```

Reused verbatim from existing code (do NOT redefine): `readState`, `readPlanVerifyVerdict`, `advancePhase`, `setStateField` (`workflow-engine.ts`); `extractStructuredVerdict`, `PlanCouncilVerdict`, `VERDICT_OUTPUT_CONTRACT` (`verdict-schema.ts`); `buildCouncilContextBundle`, `renderCouncilContextBlock`, `CouncilContextBundle` (`council-context.ts`); `resolvePlanCouncilLeader` (`council/leader.ts`); `planningArtifact` (`paths.ts`); `isGsdNativeEnabled` (`flags.ts`).

---

### Task 1: `gsdGateBlocking` on PipelineContext + propagate from layer4

**Files:**
- Modify: `src/pil/types.ts` (add field near `complexityTier`)
- Modify: `src/pil/layer4-gsd.ts:172` (assign local), `:187-191` (return field)
- Test: `src/pil/__tests__/layer4-gsd.test.ts`

**Interfaces:**
- Produces: `PipelineContext.gsdGateBlocking?: boolean | null` — read by Task 4's gate.

- [ ] **Step 1: Write the failing test** — append to `src/pil/__tests__/layer4-gsd.test.ts`:

```ts
it("sets gsdGateBlocking=true on a heavy implementation ctx", async () => {
  const ctx = makeCtx({ raw: "refactor the entire auth subsystem end to end", deliverableKind: "code" });
  const out = await runLayer4Gsd(ctx); // use the file's existing entry point / helper name
  expect(out.gsdGateBlocking).toBe(true);
});

it("leaves gsdGateBlocking falsy on a standard/informational ctx", async () => {
  const ctx = makeCtx({ raw: "what does this function do?", deliverableKind: "report" });
  const out = await runLayer4Gsd(ctx);
  expect(out.gsdGateBlocking).toBeFalsy();
});
```

> Match the existing test's helper names (`makeCtx`, the exported layer-4 entry). Read the top of the spec first to reuse its scaffolding rather than inventing new helpers.

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: FAIL — `gsdGateBlocking` is `undefined`.

- [ ] **Step 3: Add the field to `PipelineContext`** in `src/pil/types.ts` (immediately after the `complexityTier` field):

```ts
  /** True when layer4 classified this turn as a heavy GSD task the mutation gate must block until plan-review passes. */
  gsdGateBlocking?: boolean | null;
```

- [ ] **Step 4: Propagate in `layer4-gsd.ts`** — in the return object (the block currently spreading `...ctx` with `gsdPhase`/`complexityTier`, ~`:187-191`), add:

```ts
    gsdGateBlocking: blocking,
```

`blocking` is already computed as `const blocking = tier === "heavy"` (~`:172`). No other change.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pil/types.ts src/pil/layer4-gsd.ts src/pil/__tests__/layer4-gsd.test.ts
git commit -m "feat(gsd): expose gsdGateBlocking on PipelineContext for the mutation gate"
```

---

### Task 2: Fix the report/implementation auto-route mis-gate

**Files:**
- Modify: `src/pil/layer4-gsd.ts:144-148`
- Test: `src/pil/__tests__/layer4-gsd.test.ts`

**Interfaces:**
- Consumes: `isImplementationIntent` (already imported at `layer4-gsd.ts:28` from `./layer6-output.js`).

**Background:** current code routes any `deliverableKind !== "code"` to the informational (question) directive, so a *"plan how to implement X"* the model tagged `deliverableKind: "report"` never enters GSD.

- [ ] **Step 1: Write failing tests** — append:

```ts
it("treats a 'plan to implement' report as NON-informational (enters GSD)", async () => {
  const ctx = makeCtx({ raw: "make a plan to implement OAuth device flow", deliverableKind: "report" });
  const out = await runLayer4Gsd(ctx);
  // enters the native GSD hint path → gsdPhase set, not the pure-question directive
  expect(out.gsdPhase).toBeTruthy();
});

it("keeps a genuine summary report informational", async () => {
  const ctx = makeCtx({ raw: "đọc và tóm tắt kiến trúc module council", deliverableKind: "report" });
  const out = await runLayer4Gsd(ctx);
  expect(out.gsdPhase).toBeFalsy();
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: FAIL on the "plan to implement" case (currently informational).

- [ ] **Step 3: Apply the fix** at `layer4-gsd.ts:144-148` — add the implementation-intent override to the deliverable branch:

```ts
  const informational = ctx.deliverableKind
    ? ctx.deliverableKind !== "code" && !isImplementationIntent(ctx.raw)
    : isMetaAnalysisPrompt(ctx.raw) ||
      (ctx.taskType === "general" && ctx.intentKind === "task") ||
      (isQuestionLike(ctx.raw) && !isImplementationIntent(ctx.raw));
```

- [ ] **Step 4: Run the full layer4 spec** (guards the existing `deliverableKind='report' is informational` case at `:178-189`)

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: PASS — both new cases and the existing summary-report case green. If "đọc và tóm tắt" now trips `isImplementationIntent`, STOP and report: the regex over-matches and Task 2 needs a tighter guard (do not weaken the test).

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer4-gsd.ts src/pil/__tests__/layer4-gsd.test.ts
git commit -m "fix(gsd): route implementation-intent reports into GSD instead of the question path"
```

---

### Task 3: Strengthen the heavy directive to a MANDATORY sequence

**Files:**
- Modify: `src/pil/layer4-gsd.ts:164-171`
- Test: `src/pil/__tests__/layer4-gsd.test.ts`

- [ ] **Step 1: Write failing test** — append:

```ts
it("emits the MANDATORY discuss→plan→plan_review sequence on heavy", async () => {
  const ctx = makeCtx({ raw: "rebuild the entire routing layer from scratch", deliverableKind: "code" });
  const out = await runLayer4Gsd(ctx);
  expect(out.enriched).toContain("MANDATORY");
  expect(out.enriched).toContain("gsd_plan_review");
  expect(out.enriched).toContain("BLOCKED");
  expect(out.enriched.length).toBeLessThan(800); // existing budget assertion at :37
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: FAIL — current soft `heavyLine` lacks "MANDATORY"/"BLOCKED".

- [ ] **Step 3: Replace the heavy directive** (`heavyLine` at `:164`, kept within the `truncateToBudget(nativeHint, 200)` cap at `:171`):

```ts
  const heavyLine =
    " MANDATORY (heavy): gsd_status → gsd_discuss → gsd_plan → gsd_plan_review BEFORE any edit_file/write_file/bash. Mutation tools are BLOCKED until plan-review passes. Start with gsd_status now.";
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/pil/__tests__/layer4-gsd.test.ts`
Expected: PASS (including the `< 800` budget assertion).

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer4-gsd.ts src/pil/__tests__/layer4-gsd.test.ts
git commit -m "feat(gsd): align heavy directive with the runtime mutation gate"
```

---

### Task 4: `evaluateMutationGate` + wire it at the write-mutex choke point

**Files:**
- Create: `src/gsd/mutation-gate.ts`
- Create: `src/gsd/__tests__/mutation-gate.test.ts`
- Modify: `src/gsd/flags.ts` (add `isGsdHardGateEnabled`)
- Modify: `src/orchestrator/tool-engine.ts` (write-mutex wrapper, ~`:1042-1077`)
- Modify: `src/gsd/index.ts` (export)

**Interfaces:**
- Consumes: `readState`, `readPlanVerifyVerdict` (`workflow-engine.js`), `isGsdNativeEnabled` (`flags.js`).
- Produces: `evaluateMutationGate`, `MutationGateDecision`, `isGsdHardGateEnabled`.

- [ ] **Step 1: Add the flag** to `src/gsd/flags.ts` (mirror the existing `isGsdNativeEnabled` env pattern — read the file first to match its exact shape):

```ts
/** Hard mutation gate — default ON when GSD native is on; opt out with MUONROI_GSD_HARD_GATE=0. */
export function isGsdHardGateEnabled(): boolean {
  if (!isGsdNativeEnabled()) return false;
  return process.env.MUONROI_GSD_HARD_GATE !== "0";
}
```

- [ ] **Step 2: Write the failing test** — `src/gsd/__tests__/mutation-gate.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateMutationGate } from "../mutation-gate.js";

function planningDir(cwd: string): string {
  const d = join(cwd, ".planning");
  mkdirSync(d, { recursive: true });
  return d;
}
function writeState(cwd: string, phase: string): void {
  writeFileSync(
    join(planningDir(cwd), "STATE.md"),
    `# STATE\n\n| Field | Value |\n|---|---|\n| Phase | ${phase} |\n| Depth | heavy |\n`,
    "utf8",
  );
}
function writePlanVerify(cwd: string, verdict: string): void {
  writeFileSync(join(planningDir(cwd), "PLAN-VERIFY.md"), `# PLAN-VERIFY\n\nverdict: ${verdict}\n`, "utf8");
}

describe("evaluateMutationGate", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "gsd-gate-")); });

  const heavy = { tier: "heavy", hardGateEnabled: true };

  it("blocks edit_file on a heavy task before plan-review passes (phase=null)", () => {
    const d = evaluateMutationGate(cwd, { ...heavy, toolName: "edit_file" });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain("gsd_status");
  });

  it("allows edit_file once phase=execute AND plan-verify=pass", () => {
    writeState(cwd, "execute");
    writePlanVerify(cwd, "pass");
    expect(evaluateMutationGate(cwd, { ...heavy, toolName: "edit_file" }).blocked).toBe(false);
  });

  it("blocks edit_file when phase=execute but plan-verify=revise", () => {
    writeState(cwd, "execute");
    writePlanVerify(cwd, "revise");
    expect(evaluateMutationGate(cwd, { ...heavy, toolName: "edit_file" }).blocked).toBe(true);
  });

  it("never blocks gsd_* / respond_* / read tools", () => {
    for (const toolName of ["gsd_plan", "gsd_discuss", "respond_report", "read_file", "grep"]) {
      expect(evaluateMutationGate(cwd, { ...heavy, toolName }).blocked).toBe(false);
    }
  });

  it("never blocks when tier is not heavy", () => {
    expect(evaluateMutationGate(cwd, { tier: "standard", hardGateEnabled: true, toolName: "edit_file" }).blocked).toBe(false);
  });

  it("never blocks when the hard gate is disabled", () => {
    expect(evaluateMutationGate(cwd, { tier: "heavy", hardGateEnabled: false, toolName: "edit_file" }).blocked).toBe(false);
  });

  it("never blocks a directAnswer turn", () => {
    expect(evaluateMutationGate(cwd, { ...heavy, toolName: "edit_file", directAnswer: true }).blocked).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bunx vitest run src/gsd/__tests__/mutation-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/gsd/mutation-gate.ts`**:

```ts
import { readPlanVerifyVerdict, readState } from "./workflow-engine.js";

export interface MutationGateDecision {
  blocked: boolean;
  /** Directive shown to the model as a ToolResult when blocked. Empty when allowed. */
  reason: string;
}

/** Tools the gate must never block: GSD workflow tools, terminal responders, read-only tools. */
const NEVER_GATED_PREFIXES = ["gsd_", "respond_"];
const NEVER_GATED_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "bash_output_get",
  "gsd_status",
]);

function isNeverGated(toolName: string): boolean {
  if (NEVER_GATED_TOOLS.has(toolName)) return true;
  return NEVER_GATED_PREFIXES.some((p) => toolName.startsWith(p));
}

const GATE_DIRECTIVE =
  "BLOCKED: this is a heavy task. GSD requires a reviewed plan before any code edit. " +
  "Call gsd_status to orient, then gsd_discuss → gsd_plan → gsd_plan_review. " +
  "Mutation tools unlock only after plan-review returns verdict: pass. " +
  "If this task is genuinely trivial, call gsd_execute with force:true to override.";

/**
 * Pure, synchronous gate. Returns {blocked:true,reason} when a mutation tool is
 * called on a heavy task before the GSD plan-review gate has passed. Never throws;
 * on any read error it fails OPEN (blocked:false) so a corrupt .planning/ never
 * bricks the turn — the deterministic caps still bound a runaway loop.
 */
export function evaluateMutationGate(
  cwd: string,
  opts: { tier: string; toolName: string; hardGateEnabled: boolean; directAnswer?: boolean },
): MutationGateDecision {
  const allow = (): MutationGateDecision => ({ blocked: false, reason: "" });
  if (!opts.hardGateEnabled) return allow();
  if (opts.tier !== "heavy") return allow();
  if (opts.directAnswer) return allow();
  if (isNeverGated(opts.toolName)) return allow();

  try {
    const state = readState(cwd);
    const verdict = readPlanVerifyVerdict(cwd);
    const gateOpen = state.phase === "execute" && verdict === "pass";
    if (gateOpen) return allow();
    return { blocked: true, reason: GATE_DIRECTIVE };
  } catch (err) {
    // Fail open — a broken .planning/ must not block real work. Log per No-Silent-Catch.
    console.error(`[gsd] mutation-gate read failed, failing open: ${(err as Error).message}`);
    return allow();
  }
}
```

- [ ] **Step 5: Run the gate tests**

Run: `bunx vitest run src/gsd/__tests__/mutation-gate.test.ts`
Expected: PASS (all 7).

- [ ] **Step 6: Wire the gate into `tool-engine.ts`** at the write-mutex wrapper (~`:1042-1077`). Read that block first. The existing loop already skips read-only + `respond_*` tools; extend the wrapped `tool.execute` to consult the gate BEFORE running the mutation. Add near the top of the file's imports:

```ts
import { evaluateMutationGate } from "../gsd/mutation-gate.js";
import { isGsdHardGateEnabled } from "../gsd/flags.js";
```

Then inside the wrapper loop, replace the wrapped execute so it checks the gate first:

```ts
    const originalExecute = tool.execute;
    tool.execute = async (input: any, context: any) => {
      const gate = evaluateMutationGate(deps.bash.getCwd(), {
        tier: depthTier,
        toolName: name,
        hardGateEnabled: isGsdHardGateEnabled(),
        directAnswer: (pilCtx as { directAnswer?: boolean }).directAnswer === true,
      });
      if (gate.blocked) {
        // Return a directive ToolResult (the safety-block pattern) — never throw,
        // so the turn stays alive and the model self-corrects into gsd_plan.
        return { output: gate.reason, isError: true };
      }
      return writeMutex.run(() => originalExecute(input, context));
    };
```

> `depthTier` is already computed at `tool-engine.ts:852-859`; `pilCtx` is in scope at the wrapper. Confirm the exact `ToolResult` shape the surrounding code returns for a blocked tool (grep the file for the bash `BLOCKED` return at ~`:2309-2368`) and match it — `{ output, isError: true }` is the expected shape but verify against that site.

- [ ] **Step 7: Export from `src/gsd/index.ts`**:

```ts
export { evaluateMutationGate, type MutationGateDecision } from "./mutation-gate.js";
export { isGsdHardGateEnabled } from "./flags.js";
```

- [ ] **Step 8: Typecheck + unit suite**

Run: `bunx tsc --noEmit && bunx vitest run src/gsd/ src/pil/`
Expected: 0 tsc errors; all green.

- [ ] **Step 9: Commit**

```bash
git add src/gsd/mutation-gate.ts src/gsd/__tests__/mutation-gate.test.ts src/gsd/flags.ts src/gsd/index.ts src/orchestrator/tool-engine.ts
git commit -m "feat(gsd): hard mutation gate blocks edits on heavy tasks until plan-review passes"
```

---

### Task 5: Escape hatches audit (env flag + directAnswer + --force)

**Files:**
- Modify: `src/gsd/__tests__/mutation-gate.test.ts` (add the `MUONROI_GSD_HARD_GATE` integration case)
- Verify (no code change expected): `gsd_execute --force` path (`workflow-tools.ts:153,158`)

> Task 4 already implemented the flag, directAnswer, and tier bypass. This task hardens the contract with an env-driven test and confirms `--force` still advances state so a forced execute opens the gate.

- [ ] **Step 1: Write the env + force integration test** — append to `mutation-gate.test.ts`:

```ts
it("honors MUONROI_GSD_HARD_GATE=0 via isGsdHardGateEnabled", async () => {
  const prev = process.env.MUONROI_GSD_HARD_GATE;
  const prevNative = process.env.MUONROI_GSD_NATIVE; // ensure native is on so the flag is meaningful
  try {
    process.env.MUONROI_GSD_NATIVE = "1";
    process.env.MUONROI_GSD_HARD_GATE = "0";
    const { isGsdHardGateEnabled } = await import("../flags.js");
    expect(isGsdHardGateEnabled()).toBe(false);
    expect(evaluateMutationGate(cwd, { tier: "heavy", toolName: "edit_file", hardGateEnabled: isGsdHardGateEnabled() }).blocked).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.MUONROI_GSD_HARD_GATE; else process.env.MUONROI_GSD_HARD_GATE = prev;
    if (prevNative === undefined) delete process.env.MUONROI_GSD_NATIVE; else process.env.MUONROI_GSD_NATIVE = prevNative;
  }
});
```

> Read `flags.ts` first to use the correct native-enable env var name (it may not be `MUONROI_GSD_NATIVE`). Match the actual name.

- [ ] **Step 2: Run**

Run: `bunx vitest run src/gsd/__tests__/mutation-gate.test.ts`
Expected: PASS.

- [ ] **Step 3: Confirm `gsd_execute --force` opens the gate** — trace: `gsd_execute` with `force:true` bypasses `canExecute` (`workflow-tools.ts:158`) and calls `advancePhase(cwd, "execute")` (`:164`). But the gate ALSO requires `readPlanVerifyVerdict === "pass"`. A forced execute on an unreviewed plan sets `phase=execute` but leaves verdict non-pass → gate still blocks. Decision: `--force` must be a full override. Add to `mutation-gate.ts` an override read: if `.planning/STATE.md` carries a forced-execute marker, open the gate. Simplest grounded approach — have `gsd_execute --force` write `setStateField(cwd, "Plan Verified", "yes")` alongside the phase advance, so the existing `readPlanVerifyVerdict` naturally returns pass. Implement in `workflow-tools.ts:156-166`:

```ts
    execute: async (input: any) => {
      const gate = canExecute(cwd, depth);
      if (!gate.allowed && !input.force) {
        return json({ blocked: true, reason: gate.reason });
      }
      if (input.force && !gate.allowed) {
        // Explicit override: record that the plan-verify gate was force-bypassed so the
        // runtime mutation gate (evaluateMutationGate) also opens. Audited via STATE.md.
        setStateField(cwd, "Plan Verified", "yes");
      }
      const host = getGsdLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth);
      await host.onExecuteStart(ctx);
      advancePhase(cwd, "execute");
      return json({ blocked: false, phase: "execute", forced: input.force === true });
    },
```

- [ ] **Step 4: Write the force test** — new case in `src/gsd/__tests__/workflow-tools.test.ts` (read the file first for its harness):

```ts
it("gsd_execute force=true opens the mutation gate (sets Plan Verified=yes, phase=execute)", async () => {
  // arrange a fresh .planning with no plan-review, call gsd_execute {force:true},
  // then assert evaluateMutationGate(cwd,{tier:'heavy',toolName:'edit_file',hardGateEnabled:true}).blocked === false
});
```

Fill the arrange/act with the file's existing tool-invocation helper.

- [ ] **Step 5: Run + Commit**

Run: `bunx vitest run src/gsd/__tests__/`
Expected: PASS.

```bash
git add src/gsd/workflow-tools.ts src/gsd/__tests__/mutation-gate.test.ts src/gsd/__tests__/workflow-tools.test.ts
git commit -m "feat(gsd): gsd_execute --force fully overrides the mutation gate (audited)"
```

---

### Task 6: Resolve auto-council ↔ GSD ordering

**Files:**
- Modify: `src/orchestrator/tool-engine.ts` (~`:626,638-642,695-701`)
- Test: harness E2E deferred to Task 9; add a focused unit assertion here if the continuation ctx is unit-testable.

**Background (UNPROVEN gap from investigation):** heavy tasks route to `runCouncilV2` and return early (`:703`), re-entering `processMessage` as a continuation (`:695-701`). If `complexityTier==="heavy"` does NOT survive onto the continuation `pilCtx`, the mutation gate never arms on the implementation turn.

- [ ] **Step 1: Verify whether heavy tier survives the continuation** — read `tool-engine.ts:695-701` and trace how the continuation `pilCtx` is built (`:696`). Determine empirically (add a temporary `console.error` of `pilCtx.complexityTier` on the continuation, run one heavy harness turn, then remove) whether the tier persists.

- [ ] **Step 2: If the tier does NOT survive**, thread it through the continuation. At the auto-council early-return (~`:695-701`), carry the tier into the re-entry so the continuation `pilCtx.complexityTier` is `"heavy"`. Grep for how the continuation prompt/ctx is assembled and set `complexityTier` explicitly on the re-entered context. (If it DOES survive, skip to Step 3 — no code change, record the finding in the ledger.)

- [ ] **Step 3: Ensure `shouldAutoCouncil` does not double-fire** — confirm at `:639` that `!isContinuation` already prevents council re-firing on the continuation turn (investigation confirms it does). No change; assert it in a comment.

- [ ] **Step 4: Typecheck + commit**

Run: `bunx tsc --noEmit && bunx vitest run src/orchestrator/`
Expected: 0 errors; green.

```bash
git add src/orchestrator/tool-engine.ts
git commit -m "fix(gsd): preserve heavy tier onto the auto-council continuation so the mutation gate arms"
```

---

### Task 7: Verify-context bundle + verify perspectives + `runVerifyCouncil`

**Files:**
- Create: `src/gsd/verify-context.ts`
- Create: `src/gsd/verify-council-prompts.ts`
- Create: `src/gsd/verify-council.ts`
- Create: `src/gsd/__tests__/verify-context.test.ts`, `src/gsd/__tests__/verify-council.test.ts`
- Modify: `src/gsd/index.ts` (exports)

**Interfaces:** see the top-level Interfaces block. Reuses `buildCouncilContextBundle`, `renderCouncilContextBlock`, `extractStructuredVerdict`, `VERDICT_OUTPUT_CONTRACT`, `resolvePlanCouncilLeader`, `planningArtifact`, `readPlanVerifyVerdict`.

- [ ] **Step 1: Write the verify-context test** — `src/gsd/__tests__/verify-context.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildVerifyContextBundle } from "../verify-context.js";

describe("buildVerifyContextBundle", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "gsd-vctx-"));
    const d = join(cwd, ".planning");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "PLAN.md"), "# Plan\n\n## Acceptance\n- login returns a token\n", "utf8");
    writeFileSync(join(d, "STATE.md"), "# STATE\n\n| Field | Value |\n|---|---|\n| Phase | verify |\n| Depth | heavy |\n", "utf8");
    writeFileSync(join(d, "PLAN-VERIFY.md"), "verdict: pass\n", "utf8");
  });

  it("carries acceptance criteria, evidence, and diff into the bundle", () => {
    const b = buildVerifyContextBundle(cwd, { depth: "heavy", evidence: "42 tests passed", diff: "diff --git a b\n+token" });
    expect(b.base.acceptanceCriteria).toContain("login returns a token");
    expect(b.evidence).toContain("42 tests passed");
    expect(b.diff).toContain("token");
    expect(b.planVerdict).toBe("pass");
    expect(b.diffChars).toBeGreaterThan(0);
  });

  it("degrades to empty diff/evidence without throwing", () => {
    const b = buildVerifyContextBundle(cwd, { depth: "heavy" });
    expect(b.diff).toBe("");
    expect(b.evidence).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/gsd/__tests__/verify-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/gsd/verify-context.ts`**:

```ts
import { buildCouncilContextBundle, type CouncilContextBundle } from "./council-context.js";
import { readPlanVerifyVerdict } from "./workflow-engine.js";

export interface VerifyContextBundle {
  base: CouncilContextBundle;
  /** Implementation diff (caller supplies; empty when unavailable). */
  diff: string;
  diffChars: number;
  /** Deterministic-floor evidence (test/lint/self-verify output). */
  evidence: string;
  /** The plan-verify verdict recorded before execution — sanity anchor. */
  planVerdict: "pass" | "revise" | "block" | null;
}

const DIFF_CAP = 8000;

function cap(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…[truncated]`;
}

/**
 * Build the context a verify-council needs: the full plan bundle (acceptance
 * criteria are the verify contract) PLUS the implementation diff and the
 * deterministic-floor evidence. Reads are tolerant — missing inputs degrade to
 * empty strings, never throw.
 */
export function buildVerifyContextBundle(
  cwd: string,
  opts: { depth: string; evidence?: string; diff?: string },
): VerifyContextBundle {
  const base = buildCouncilContextBundle(cwd, { depth: opts.depth });
  const diff = cap(opts.diff ?? "", DIFF_CAP);
  const evidence = cap(opts.evidence ?? "", 4000);
  return {
    base,
    diff,
    diffChars: diff.length,
    evidence,
    planVerdict: readPlanVerifyVerdict(cwd),
  };
}
```

- [ ] **Step 4: Run**

Run: `bunx vitest run src/gsd/__tests__/verify-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/gsd/verify-council-prompts.ts`**:

```ts
import { renderCouncilContextBlock } from "./council-context.js";
import type { VerifyContextBundle } from "./verify-context.js";
import { VERDICT_OUTPUT_CONTRACT } from "./verdict-schema.js";

export type VerifyPerspectiveId = "acceptance" | "correctness" | "regression" | "security";

export interface VerifyPerspective {
  id: VerifyPerspectiveId;
  role: string;
  mandate: string;
}

export const VERIFY_PERSPECTIVES: VerifyPerspective[] = [
  {
    id: "acceptance",
    role: "acceptance auditor",
    mandate: "For EACH acceptance criterion, cite the diff line or evidence that satisfies it. Any criterion without concrete evidence is a concern.",
  },
  {
    id: "correctness",
    role: "adversarial correctness reviewer",
    mandate: "Try to REFUTE that the implementation works. Construct a concrete failing input or state. Default to a concern when uncertain.",
  },
  {
    id: "regression",
    role: "regression reviewer",
    mandate: "Identify behavior OUTSIDE the task scope that the diff may have broken (removed guards, changed signatures, side effects).",
  },
  {
    id: "security",
    role: "security reviewer",
    mandate: "Path traversal, secret handling, permission changes, dangerous shell patterns introduced by the diff.",
  },
];

/** standard = acceptance + correctness; heavy = all four; quick = none (deterministic floor only). */
export function verifyPerspectivesForDepth(depth: string): VerifyPerspective[] {
  if (depth === "quick") return [];
  if (depth === "standard") return VERIFY_PERSPECTIVES.filter((p) => p.id === "acceptance" || p.id === "correctness");
  return VERIFY_PERSPECTIVES;
}

function renderBundle(bundle: VerifyContextBundle): string {
  return [
    renderCouncilContextBlock(bundle.base),
    "",
    "### Deterministic-floor evidence (tests/lint/self-verify)",
    "",
    bundle.evidence || "(no evidence supplied)",
    "",
    "### Implementation diff under review",
    "",
    "```diff",
    bundle.diff || "(no diff supplied)",
    "```",
  ].join("\n");
}

export function buildVerifyPerspectivePrompt(p: VerifyPerspective, bundle: VerifyContextBundle): string {
  return [
    `You are the ${p.role} on a verify council judging whether an implementation meets its plan.`,
    `Mandate: ${p.mandate}`,
    "",
    "The deterministic test floor has already PASSED. Your job is intent-vs-reality: does the code",
    "actually achieve the plan's goal and acceptance criteria? Tests passing is necessary, not sufficient.",
    "",
    renderBundle(bundle),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}

export function buildVerifyDebateTopic(bundle: VerifyContextBundle): string {
  return [
    "Debate whether the implementation below satisfies the plan's goal and acceptance criteria.",
    "The deterministic test floor already passed — focus on goal-achievement, missed acceptance criteria,",
    "and regressions. Converge on a single merged verdict.",
    "",
    renderBundle(bundle),
    "",
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}
```

- [ ] **Step 6: Write the verify-council test** — `src/gsd/__tests__/verify-council.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/leader.js", () => ({
  resolvePlanCouncilLeader: vi.fn(async () => ({ modelId: "leader-model" })),
}));

import { runVerifyCouncil } from "../verify-council.js";

function seed(cwd: string): void {
  const d = join(cwd, ".planning");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "PLAN.md"), "# Plan\n\n## Acceptance\n- returns a token\n", "utf8");
  writeFileSync(join(d, "STATE.md"), "# STATE\n\n| Field | Value |\n|---|---|\n| Phase | verify |\n| Depth | heavy |\n", "utf8");
  writeFileSync(join(d, "PLAN-VERIFY.md"), "verdict: pass\n", "utf8");
}

describe("runVerifyCouncil", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "gsd-vc-")); seed(cwd); });

  it("returns pass and writes VERIFY-COUNCIL.md when every perspective approves", async () => {
    const runPerspectiveFn = vi.fn(async () => '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":["token at L3"],"rationale":"ok"}\n```');
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", evidence: "42 passed", runPerspectiveFn });
    expect(res.verdict).toBe("pass");
    expect(res.skipped).toBe(false);
    expect(existsSync(join(cwd, ".planning", "VERIFY-COUNCIL.md"))).toBe(true);
  });

  it("returns revise and collects concerns when a perspective flags a gap", async () => {
    const runPerspectiveFn = vi.fn(async (_p, p) =>
      p.id === "correctness"
        ? '```council-verdict\n{"verdict":"revise","concerns":["null token on empty password"],"evidence":[],"rationale":"gap"}\n```'
        : '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":[],"rationale":"ok"}\n```',
    );
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", runPerspectiveFn });
    expect(res.verdict).toBe("revise");
    expect(res.concerns.join(" ")).toContain("null token");
  });

  it("skips (verdict pass, skipped true) at quick depth — deterministic floor only", async () => {
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "quick" });
    expect(res.skipped).toBe(true);
    expect(res.verdict).toBe("pass");
  });

  it("forces revise (never silently approves) when the debate emits no structured verdict", async () => {
    const runDebate = vi.fn(async () => "some prose with no fenced verdict block");
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", runDebate });
    expect(res.verdict).toBe("revise");
    expect(res.verdictSource).toBe("parse-failed");
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `bunx vitest run src/gsd/__tests__/verify-council.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `src/gsd/verify-council.ts`** (mirror `plan-council.ts` structure — debate path preferred, perspective path fallback, conservative parse-fail):

```ts
import { writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import { planningArtifact } from "./paths.js";
import { extractStructuredVerdict } from "./verdict-schema.js";
import { buildVerifyContextBundle } from "./verify-context.js";
import {
  buildVerifyDebateTopic,
  buildVerifyPerspectivePrompt,
  type VerifyPerspective,
  verifyPerspectivesForDepth,
} from "./verify-council-prompts.js";

export type VerifyVerdict = "pass" | "revise" | "block";

export interface VerifyCouncilResult {
  skipped: boolean;
  verdict: VerifyVerdict;
  concerns: string[];
  verifyCouncilPath?: string;
  leaderModelId?: string;
  verdictSource: "structured" | "heuristic-fallback" | "parse-failed";
}

export interface VerifyCouncilOpts {
  cwd: string;
  sessionModelId: string;
  depth: string;
  evidence?: string;
  diff?: string;
  runPerspectiveFn?: (prompt: string, p: VerifyPerspective) => Promise<string>;
  runDebate?: (topic: string) => Promise<string>;
}

/** approve → pass; else the worst verdict wins (block > revise). */
function mergeVerdict(verdicts: ("approve" | "revise" | "block")[]): VerifyVerdict {
  if (verdicts.some((v) => v === "block")) return "block";
  if (verdicts.some((v) => v === "revise")) return "revise";
  return "pass";
}

function writeArtifact(cwd: string, verdict: VerifyVerdict, concerns: string[], leaderModelId: string, source: string): string {
  const path = planningArtifact(cwd, "VERIFY-COUNCIL.md");
  const content = [
    "# VERIFY-COUNCIL",
    "",
    `verdict: ${verdict}`,
    `leader: \`${leaderModelId}\``,
    `verdictSource: ${source}`,
    "",
    "## Concerns",
    concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

/**
 * Independent council adjudication of an implementation against its plan.
 * Runs ONLY after the deterministic test floor passes (caller's contract).
 * Never silently approves: a missing structured verdict forces "revise".
 */
export async function runVerifyCouncil(opts: VerifyCouncilOpts): Promise<VerifyCouncilResult> {
  const perspectives = verifyPerspectivesForDepth(opts.depth);
  if (perspectives.length === 0) {
    return { skipped: true, verdict: "pass", concerns: [], verdictSource: "structured" };
  }

  const bundle = buildVerifyContextBundle(opts.cwd, { depth: opts.depth, evidence: opts.evidence, diff: opts.diff });
  const leader = await resolvePlanCouncilLeader(opts.sessionModelId);

  // ---- Debate path (production: runCouncilV2 synthesis) ----
  if (opts.runDebate) {
    let synthesis = "";
    try {
      synthesis = await opts.runDebate(buildVerifyDebateTopic(bundle));
    } catch (err) {
      console.error(`[gsd] verify-council debate failed: ${(err as Error).message}`);
    }
    const parsed = extractStructuredVerdict(synthesis);
    if (!parsed) {
      const concerns = ["Verify council leader emitted no structured verdict — forcing revision."];
      const path = writeArtifact(opts.cwd, "revise", concerns, leader.modelId, "parse-failed");
      return { skipped: false, verdict: "revise", concerns, verifyCouncilPath: path, leaderModelId: leader.modelId, verdictSource: "parse-failed" };
    }
    const verdict = mergeVerdict([parsed.verdict]);
    const concerns = parsed.concerns.map(String);
    const path = writeArtifact(opts.cwd, verdict, concerns, leader.modelId, "structured");
    return { skipped: false, verdict, concerns, verifyCouncilPath: path, leaderModelId: leader.modelId, verdictSource: "structured" };
  }

  // ---- Perspective path (parallel sub-agents; tests use this) ----
  if (!opts.runPerspectiveFn) {
    // No runner at all — cannot adjudicate; conservatively pass (deterministic floor already gated).
    return { skipped: true, verdict: "pass", concerns: [], verdictSource: "structured" };
  }
  const runFn = opts.runPerspectiveFn;
  const results = await Promise.all(
    perspectives.map(async (p) => {
      try {
        const raw = await runFn(buildVerifyPerspectivePrompt(p, bundle), p);
        const parsed = extractStructuredVerdict(raw);
        if (!parsed) {
          console.error(`[gsd] verify-council perspective ${p.id} emitted no structured verdict — forcing revise`);
          return { verdict: "revise" as const, concerns: [`${p.id}: no structured verdict (parse failed)`], parseFailed: true };
        }
        return { verdict: parsed.verdict, concerns: parsed.concerns.map(String), parseFailed: false };
      } catch (err) {
        console.error(`[gsd] verify-council perspective ${p.id} failed: ${(err as Error).message}`);
        return { verdict: "revise" as const, concerns: [`${p.id}: perspective error — ${(err as Error).message}`], parseFailed: true };
      }
    }),
  );
  const verdict = mergeVerdict(results.map((r) => r.verdict));
  const concerns = results.flatMap((r) => r.concerns);
  const anyParseFailed = results.some((r) => r.parseFailed);
  const source = anyParseFailed ? "parse-failed" : "structured";
  const path = writeArtifact(opts.cwd, verdict, concerns, leader.modelId, source);
  return { skipped: false, verdict, concerns, verifyCouncilPath: path, leaderModelId: leader.modelId, verdictSource: source };
}
```

- [ ] **Step 9: Run the verify-council tests**

Run: `bunx vitest run src/gsd/__tests__/verify-council.test.ts src/gsd/__tests__/verify-context.test.ts`
Expected: PASS (all cases). Note the debate parse-fail case maps to `revise` (never silent approve).

- [ ] **Step 10: Export from `src/gsd/index.ts`**:

```ts
export { runVerifyCouncil, type VerifyCouncilResult } from "./verify-council.js";
export { buildVerifyContextBundle, type VerifyContextBundle } from "./verify-context.js";
export { verifyPerspectivesForDepth, type VerifyPerspective } from "./verify-council-prompts.js";
```

- [ ] **Step 11: Typecheck + commit**

Run: `bunx tsc --noEmit && bunx vitest run src/gsd/`
Expected: 0 errors; green.

```bash
git add src/gsd/verify-context.ts src/gsd/verify-council-prompts.ts src/gsd/verify-council.ts src/gsd/__tests__/verify-context.test.ts src/gsd/__tests__/verify-council.test.ts src/gsd/index.ts
git commit -m "feat(gsd): council-adjudicated verify layer (mirror of plan-council)"
```

---

### Task 8: Wire Layer-2 verify-council into `gsd_verify`

**Files:**
- Modify: `src/gsd/workflow-tools.ts:169-205` (`gsd_verify`)
- Test: `src/gsd/__tests__/workflow-tools.test.ts`

**Contract:** deterministic floor first. If `passed=false` OR no evidence → straight to debug/fail, NO council (cheap). If `passed=true` with evidence AND depth≠quick → run `runVerifyCouncil`; its verdict OVERRIDES the model's self-report: `pass`→review, `revise`/`block`→debug with concerns fed into VERIFY.md.

- [ ] **Step 1: Write the failing test** — append to `src/gsd/__tests__/workflow-tools.test.ts` (read the file for its tool-invocation + opts harness; `runTask`/`runDebate` are injected via `GsdWorkflowToolOpts`):

```ts
it("gsd_verify runs verify-council when passed=true at heavy depth and honors its verdict", async () => {
  // arrange: depth 'heavy', a .planning with PLAN.md acceptance + PLAN-VERIFY pass,
  // inject runTask/runDebate opts whose synthesis returns a 'revise' council-verdict.
  // act: call gsd_verify {passed:true, evidence:"tests green"}
  // assert: returned phase is 'debug' (council revise overrode the model's passed=true),
  //         and VERIFY-COUNCIL.md exists with verdict: revise.
});

it("gsd_verify skips council on passed=false (deterministic fail → debug, no council)", async () => {
  // act: gsd_verify {passed:false}; assert phase 'debug' and NO VERIFY-COUNCIL.md written.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/gsd/__tests__/workflow-tools.test.ts`
Expected: FAIL — council not wired.

- [ ] **Step 3: Wire it** — modify the `gsd_verify` execute body (`workflow-tools.ts:180-204`). After the deterministic-floor evidence check, before `onVerifyComplete`, run the council when the floor passed:

```ts
    execute: async (input: any) => {
      const passed = input.passed === true;
      if (passed && !input.evidence?.trim()) {
        return json({ ok: false, error: "gsd_verify requires non-empty evidence when passed=true" });
      }

      // Layer 2: council adjudication ONLY when the deterministic floor passed at non-quick depth.
      // The council verdict overrides the model's self-reported `passed` — this is the whole point:
      // "tests green but doesn't meet the goal" is caught here.
      let effectivePassed = passed;
      let councilConcerns: string[] = [];
      if (passed && depth !== "quick") {
        try {
          const { runVerifyCouncil } = await import("./verify-council.js");
          const diff = await readImplementationDiff(cwd); // helper below
          const council = await runVerifyCouncil({
            cwd,
            sessionModelId,
            depth,
            evidence: input.evidence?.trim(),
            diff,
            runPerspectiveFn: runTask ? taskToRunPerspectiveFn(runTask, sessionModelId) : undefined,
            runDebate: opts.runDebate,
          });
          if (!council.skipped && council.verdict !== "pass") {
            effectivePassed = false;
            councilConcerns = council.concerns;
          }
        } catch (err) {
          // Fail OPEN — a council failure must not block a genuinely-passing verify. Log per No-Silent-Catch.
          console.error(`[gsd] verify-council wiring failed, honoring deterministic floor: ${(err as Error).message}`);
        }
      }

      const verdictLine = effectivePassed ? "verdict: pass" : "verdict: fail";
      const concernBlock = councilConcerns.length ? `\n\n## Council concerns\n${councilConcerns.map((c) => `- ${c}`).join("\n")}` : "";
      if (input.evidence?.trim() || councilConcerns.length) {
        writeFileSync(planningArtifact(cwd, "VERIFY.md"), `${verdictLine}\n\n${input.evidence?.trim() ?? ""}${concernBlock}\n`, "utf8");
      }

      const host = getGsdLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth, {
        sessionId,
        verifyPassed: effectivePassed,
        verifyEvidence: { evidence: input.evidence?.trim(), evidenceChars: input.evidence?.length ?? 0, passed: effectivePassed },
      });
      const verifyResult = await host.onVerifyComplete(ctx);
      return json({ ok: true, phase: effectivePassed ? "review" : "debug", passed: effectivePassed, councilConcerns, loop: verifyResult });
    },
```

Add the diff helper near the top of `workflow-tools.ts` (uses `git diff` via the deps? `gsd_verify` has no bash dep — read the plan's execute phase start). Simplest grounded approach: capture the diff from git HEAD in the cwd:

```ts
import { execFileSync } from "node:child_process";

/** Best-effort implementation diff for the verify council. Empty on any failure — never throws. */
async function readImplementationDiff(cwd: string): Promise<string> {
  try {
    return execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    console.error(`[gsd] verify-council diff capture failed: ${(err as Error).message}`);
    return "";
  }
}
```

> `taskToRunPerspectiveFn` is already imported at `workflow-tools.ts:6` — reuse it (same adapter plan-review uses). Confirm `runTask` and `opts.runDebate` are in scope in `gsd_verify` (they are destructured/available via `GsdWorkflowToolOpts`).

- [ ] **Step 4: Run**

Run: `bunx vitest run src/gsd/__tests__/workflow-tools.test.ts`
Expected: PASS — heavy passed=true with a revise council → phase `debug`; passed=false → debug, no council file.

- [ ] **Step 5: Full gsd suite + typecheck**

Run: `bunx tsc --noEmit && bunx vitest run src/gsd/`
Expected: 0 errors; green.

- [ ] **Step 6: Commit**

```bash
git add src/gsd/workflow-tools.ts src/gsd/__tests__/workflow-tools.test.ts
git commit -m "feat(gsd): gsd_verify runs council adjudication on top of the deterministic floor"
```

---

### Task 9: Harness E2E — gated flow + verify-council + deadlock bound

**Files:**
- Create: `tests/harness/gsd-hard-gate.spec.ts`
- Create: `tests/harness/fixtures/llm/gsd-hard-gate.json` (mock-LLM script)

**Verification per repo rule:** drive the real CLI via the harness (`spawnHarness`), not just unit mocks. Run in a **fresh greenfield temp cwd** (per the known-caveat about repo-root scan cost).

- [ ] **Step 1: Write the fixture** — `tests/harness/fixtures/llm/gsd-hard-gate.json` scripting a heavy task where the model first tries `edit_file` (must be blocked), then follows the gsd sequence (must unblock). Follow the shape in existing `tests/harness/fixtures/llm/*.json`.

- [ ] **Step 2: Write the spec** — `tests/harness/gsd-hard-gate.spec.ts` using `spawnHarness({ cwd })` (fresh temp dir). Assert:
  1. On a heavy prompt, a direct `edit_file` attempt returns the BLOCKED directive (via the tool result / a toast / `render_text`).
  2. After `gsd_status → gsd_discuss → gsd_plan → gsd_plan_review` (council pass), an `edit_file` succeeds.
  3. Deadlock bound: a model that repeats `edit_file` without planning trips the existing repetition guard → clean turn abort (no hang). Assert the turn ends within the spec timeout.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHarness } from "./helpers";

describe("GSD hard gate E2E", () => {
  let h: Awaited<ReturnType<typeof spawnHarness>>;
  const cwd = mkdtempSync(join(tmpdir(), "gsd-e2e-"));
  beforeAll(async () => {
    h = await spawnHarness({ cwd, mockLlm: "gsd-hard-gate", env: { MUONROI_GSD_HARD_GATE: "1", MUONROI_GSD_NATIVE: "1" } });
  }, 60_000);
  afterAll(() => h?.stop());

  it("blocks edit_file on a heavy task before plan-review, unblocks after", async () => {
    // drive the fixture; assert BLOCKED directive then success. Use driver.wait_for on events.
  });
});
```

Fill the driver interactions to match the fixture. Use `driver.events()` for the gate/toast lifecycle (per the event-driven pattern in `tests/harness/events.spec.ts`).

- [ ] **Step 3: Run on Windows (named pipe)**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/gsd-hard-gate.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/harness/gsd-hard-gate.spec.ts tests/harness/fixtures/llm/gsd-hard-gate.json
git commit -m "test(harness): E2E for GSD hard gate + verify-council + deadlock bound"
```

---

### Task 10: Document the gate contract + env flags

**Files:**
- Modify: `CLAUDE.md` (add a "GSD Hard Gate" section near the BB-aware `/ideal` section)

- [ ] **Step 1: Add the doc section** covering: gate-open condition (`phase==="execute"` AND plan-verify `pass`, heavy tier only); the MANDATORY sequence; escape hatches (`MUONROI_GSD_HARD_GATE=0`, `gsd_execute --force`, non-heavy/directAnswer bypass); the two-layer verify (deterministic floor + `runVerifyCouncil`); artifact locations (`.planning/VERIFY-COUNCIL.md`). Keep it factual — cite the module paths (`src/gsd/mutation-gate.ts`, `src/gsd/verify-council.ts`).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: GSD hard-gate + council-verified verify contract"
```

---

## Final gate (before push)

- [ ] `bunx tsc --noEmit` — 0 errors
- [ ] `bunx vitest run` — full suite 0 failures (Pre-Push Test Gate — no exceptions)
- [ ] `bunx vitest -c vitest.harness.config.ts run tests/harness/` — harness green
- [ ] `bun run lint:semantic` + `bun run lint:harness-skips` if UI/harness touched
- [ ] Self-verify Tier 1 on touched watched surfaces (`tool-engine.ts` is watched)

---

## Self-Review notes (author checklist — done)

- **Spec coverage:** hard gate (T1-T6), verify-council (T7-T8), E2E (T9), docs (T10) — every thread from both the investigation report and the user's verify+council request has a task.
- **Type consistency:** `evaluateMutationGate`, `VerifyContextBundle`, `VerifyCouncilResult`, `runVerifyCouncil` signatures match between the Interfaces block and each task body. `verifyPerspectivesForDepth` naming consistent throughout.
- **UNPROVEN carry-forwards (must resolve during execution, not assume):**
  1. T2 — confirm `IMPLEMENTATION_INTENT_RE` matches "plan to implement" WITHOUT false-positiving on "đọc và tóm tắt" (Step 4 gates this).
  2. T6 — confirm heavy tier survives the auto-council continuation turn (Step 1 measures it empirically).
  3. T8 — confirm `runTask` + `opts.runDebate` are in scope inside `gsd_verify` (they are on `GsdWorkflowToolOpts`; verify before wiring).
  4. T4 Step 6 — confirm the exact blocked-`ToolResult` shape by matching the bash `BLOCKED` return site (`tool-engine.ts:~2309-2368`).
