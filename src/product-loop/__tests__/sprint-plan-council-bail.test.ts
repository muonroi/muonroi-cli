/**
 * sprint-plan-council-bail.test.ts — P0-1 regression.
 *
 * ROOT CAUSE (measured live 2026-09-04, run mtmkya3uaf85 on step-3.7-flash):
 * `/ideal` stopped at "Sprint 1 — Planning" printing only
 * "No reachable provider. Check API keys…" and then produced NOTHING — no halt
 * card, no error, no terminal event, no completion. `MUONROI_IDEAL_TRACE`
 * showed `sprint.planCouncil.before` as the LAST line ever written; the matching
 * `sprint.planCouncil.after` never fired.
 *
 * Two independent defects combined at this seam:
 *
 *  1. `runCouncil`'s early-bail paths (`participants.length < 2`, user abort, no
 *     openings, …) yield `{type:"done"}` — the TURN terminator the TUI consumes
 *     to end its `for await` (`use-app-logic.tsx`: `if (chunk.type === "done")
 *     break;`). Under `sprintPlanningMode` that council is a SUB-STEP of the
 *     sprint runner, not a turn, so `sprint-runner` forwarded a terminator that
 *     tore the enclosing `/ideal` run down mid-sprint. The terminal `done` at
 *     the end of `runCouncil` was already gated on `sprintPlanningMode`; the
 *     eight early bails were not.
 *
 *  2. Even ignoring the terminator, a bail returns `null`, which became
 *     `planSynthesis = ""` and the sprint marched on with an empty plan — a
 *     silent degradation with no verdict.
 *
 * These tests assert the seam invariants directly: no `done` escapes runSprint,
 * and a bailing planning council becomes a THROWN, accountable failure (which
 * product-loop/index.ts turns into a persisted sprint_halt + recovery card).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const councilBehaviour: { mode: "bail" | "ok" } = { mode: "bail" };

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(() =>
    (async function* () {
      if (councilBehaviour.mode === "bail") {
        // Verbatim shape of src/council/index.ts:883-889 BEFORE the fix — the
        // regression this test pins is that sprint-runner must not let this
        // terminator through even if a council path emits one.
        yield { type: "content", content: "\nNo reachable provider. Check API keys…\n" };
        yield { type: "done" };
        return null;
      }
      yield { type: "content", content: "planning…" };
      return "## Plan\n- do the thing\n";
    })(),
  ),
}));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false, reason: "" })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
}));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  reserveForProduct: vi.fn(async () => ({
    id: "tok",
    model: "m",
    provider: "p",
    projected_usd: 0.1,
    est_input_tokens: 100,
    est_output_tokens: 100,
    createdAtMs: 0,
  })),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => ({
    idea: "greenfield idea",
    detection: { classification: "greenfield" },
    context: {},
  })),
}));

import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let testFlowDir = "";
beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-plan-bail-"));
  vi.clearAllMocks();
  councilBehaviour.mode = "bail";
});
afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

function makeSpec(): ProductSpec {
  return {
    idea: "greenfield idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  } as ProductSpec;
}

function makeCtx(): unknown {
  return {
    runId: "run-plan-bail",
    flowDir: testFlowDir,
    cwd: testFlowDir,
    idea: "greenfield idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "impl" };
    }),
    detectVerifyRecipe: async () => null,
  };
}

/** Drain until return or throw; reports both the chunks and the outcome. */
async function drain(
  gen: AsyncGenerator<unknown, unknown, unknown>,
): Promise<{ chunks: Array<Record<string, unknown>>; error?: Error }> {
  const chunks: Array<Record<string, unknown>> = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks };
      chunks.push(value as Record<string, unknown>);
    }
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

describe("runSprint — planning council bail (P0-1)", () => {
  it("never forwards the planning council's {type:'done'} turn terminator", async () => {
    const { chunks } = await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }) as never,
    );

    // The TUI ends the whole /ideal run on the first `done` it sees. A sub-step
    // council must never be able to emit one through this seam.
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    // The council's own explanatory content DID reach the user (we suppress the
    // terminator, not the diagnosis).
    expect(chunks.some((c) => c.type === "content" && String(c.content ?? "").includes("No reachable provider"))).toBe(
      true,
    );
  });

  it("turns a bailing planning council into a THROWN sprint failure, not an empty plan", async () => {
    const { chunks, error } = await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }) as never,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/planning council produced no plan/i);

    // The planning phase closes in the `error` state so the TUI timeline does
    // not leave "Sprint 1 — Planning" spinning forever.
    const planErr = chunks.find(
      (c) =>
        c.type === "council_phase" &&
        (c.councilPhase as { phaseId?: string; state?: string } | undefined)?.phaseId === "sprint-1-planning" &&
        (c.councilPhase as { state?: string } | undefined)?.state === "error",
    );
    expect(planErr).toBeTruthy();
  });

  it("a council that DOES synthesise proceeds normally (no over-throwing)", async () => {
    councilBehaviour.mode = "ok";
    const { chunks, error } = await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }) as never,
    );

    // Whatever downstream stages do, the PLANNING stage must not have thrown
    // the no-plan error, and it must have closed `done`, not `error`.
    expect(error?.message ?? "").not.toMatch(/planning council produced no plan/i);
    const planDone = chunks.find(
      (c) =>
        c.type === "council_phase" &&
        (c.councilPhase as { phaseId?: string } | undefined)?.phaseId === "sprint-1-planning" &&
        (c.councilPhase as { state?: string } | undefined)?.state === "done",
    );
    expect(planDone).toBeTruthy();
  });
});
