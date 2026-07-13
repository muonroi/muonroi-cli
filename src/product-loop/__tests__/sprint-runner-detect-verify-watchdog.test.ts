/**
 * sprint-runner-detect-verify-watchdog.test.ts
 *
 * Regression for the /ideal wedge reproduced live 2026-07-13: runSprint Step 2
 * (`detectVerifyRecipe`) runs a `verify-detect` LLM sub-agent turn that can finish
 * its stream then hang on the JS side afterward. The call site at sprint-runner.ts
 * had a BARE `await` (no deadline), so a single hung verify-detect turn bricked the
 * whole run silently — right after "Committed: N sprints planned", before the
 * "Sprint N — Planning" yield.
 *
 * Fix: the call is now wrapped in `withDeadlineRace(..., getIsolatedTaskDeadlineMs())`
 * inside a try/catch, so a hang/failure surfaces as `verifyRecipe = null` → CB-3
 * emits the actionable recovery card instead of wedging.
 *
 * The wall-clock timeout itself is covered by src/utils/__tests__/llm-deadline.test.ts
 * (withDeadlineRace rejects on deadline). Here we assert the sprint-runner call-site
 * contract: a rejecting/failing detectVerifyRecipe no longer throws out of runSprint —
 * it degrades to a null recipe and reaches CB-3.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: true, reason: "no_recipe" })),
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
    createdAtMs: Date.now(),
  })),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { CB3_verifyBlank } from "../circuit-breakers.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let testFlowDir = "/tmp/flow";
beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-detect-verify-"));
  vi.clearAllMocks();
  (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ halt: true, reason: "no_recipe" });
});
afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

function makeCtx(detectVerifyRecipe: () => Promise<unknown>): unknown {
  return {
    runId: "run-detect-verify",
    flowDir: testFlowDir,
    cwd: "/tmp/cwd",
    idea: "test idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "impl" };
    }),
    detectVerifyRecipe,
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; ret: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, ret: value as R };
    chunks.push(value as T);
  }
}

describe("runSprint Step 2 — detectVerifyRecipe watchdog", () => {
  it("does not throw when detectVerifyRecipe rejects — degrades to null → CB-3 halt", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error("verify-detect turn failed");
    });

    // Before the fix this rejected out of runSprint (bare await). Now it must be
    // caught and mapped to a CB-3 halt path — the generator completes cleanly.
    const { chunks } = await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx(rejecting) as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    );

    // CB-3 was consulted with a null recipe and produced the actionable halt card.
    expect(CB3_verifyBlank).toHaveBeenCalledWith(1, null);
    const halt = chunks.find((c) => (c as { type?: string }).type === "halt");
    expect(halt).toBeTruthy();
  });

  it("passes a resolved recipe straight through (no regression on the happy path)", async () => {
    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ halt: true, reason: "check" });
    const recipe = { testCommands: ["pytest"], coverage: 80, shellInitCommands: [] };
    const resolving = vi.fn(async () => recipe);

    await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx(resolving) as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    );

    expect(CB3_verifyBlank).toHaveBeenCalledWith(1, recipe);
  });
});
