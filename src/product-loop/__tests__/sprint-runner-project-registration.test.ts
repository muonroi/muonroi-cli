/**
 * sprint-runner-project-registration.test.ts — S6 wiring, blocker #1 proof.
 *
 * Independent acceptance review rejected the first S6 slice: the project-
 * registration check sat inside `runVerifyAndFloorPass`'s pre-existing
 * `if (verifyVerdict === "PASS" || verifyVerdict === "UNKNOWN")` branch, so a
 * sprint whose verify sub-agent reported FAIL never ran it at all. Live run
 * `mu54vrme4c87` sprint 1 was itself a FAIL — exactly the case this check
 * exists for.
 *
 * This file proves the check now runs UNCONDITIONALLY (mocking
 * `checkProjectRegistration` itself, not a real git repo — `sprint-runner.ts`
 * is the thing under proof, not the checker's own git plumbing, which
 * `project-registration-check.test.ts` already covers against real repos),
 * and that its must-fix text reaches both the S4 fixer's prompt and the next
 * sprint's `nextFocus` even on a FAIL verdict.
 */

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
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
vi.mock("../cost-scoper.js", () => ({ recordProductSpend: vi.fn(async () => undefined) }));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));
vi.mock("../plan-adherence-review.js", async (importOriginal) => {
  // Real adherence review would ALSO call ctx.runIsolatedTask for its own
  // reviewer/fixer turns, polluting the fixer-call assertions below with
  // calls unrelated to S6. It is not what this file is proving — stub it to
  // "adherent, nothing to fix" so only the S4 verify-fix loop below calls
  // runIsolatedTask.
  const actual = await importOriginal<typeof import("../plan-adherence-review.js")>();
  return {
    ...actual,
    // biome-ignore lint/correctness/useYield: matches the real AsyncGenerator<StreamChunk, AdherenceVerdict> contract; nothing worth emitting.
    runPlanAdherenceReview: vi.fn(async function* () {
      return { adherent: true, deviations: [], rounds: 0, stopReason: "approved", taskVerdicts: [] };
    }),
  };
});
// Mocked so the test never touches git/fs for the checker's own logic — that
// is project-registration-check.test.ts's job. Only the WIRING is under proof
// here: does sprint-runner call it regardless of verifyVerdict, and does its
// output reach the right places.
vi.mock("../project-registration-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../project-registration-check.js")>();
  return { ...actual, checkProjectRegistration: vi.fn() };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { checkProjectRegistration, type ProjectRegistrationCheckResult } from "../project-registration-check.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
let testFlowDir = "/tmp/flow";

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "run-s6-wiring",
    flowDir: testFlowDir,
    cwd: "/tmp/cwd-s6",
    idea: "test idea",
    llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    ...overrides,
  };
}

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

async function drain<T, R>(
  gen: AsyncGenerator<T, R, unknown>,
): Promise<{ chunks: T[]; result: R | undefined; error?: unknown }> {
  const chunks: T[] = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, result: value as R };
      chunks.push(value);
    }
  } catch (error) {
    return { chunks, result: undefined, error };
  }
}

const VIOLATING_RESULT: ProjectRegistrationCheckResult = {
  ecosystems: [
    {
      ecosystem: "C#",
      solutionFile: "Acme.sln",
      unregistered: [
        {
          manifest: "src/src/Acme.Widgets/Acme.Widgets.csproj",
          reason: 'not referenced by "Acme.sln"',
          solutionFile: "Acme.sln",
        },
      ],
      status: "violations",
    },
  ],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 1,
};

const CLEAN_RESULT: ProjectRegistrationCheckResult = {
  ecosystems: [{ ecosystem: "C#", solutionFile: "Acme.sln", unregistered: [], status: "ok" }],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 1,
};

beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-s6-"));
  vi.clearAllMocks();
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
});

afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

describe("S6 wiring — the project-registration check runs independent of the verify verdict", () => {
  it("verify FAILs, a project is unregistered: the check still runs, the fixer prompt and nextFocus both carry the must-fix text, and the loop triggers", async () => {
    // The verify sub-agent reports FAIL on every round (no build/typecheck
    // project exists at cwd, so the floor itself is "unavailable" — this
    // isolates the assertion to S6, not S5's own floor).
    (runVerifyOrchestration as any).mockResolvedValue({
      success: false,
      output: "VERIFY_FAIL\n1 assertion failed",
    });
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      score: 0,
      failedCondition: "engineering_floor",
      reason: "FAIL",
    });
    (checkProjectRegistration as any).mockResolvedValue(VIOLATING_RESULT);

    const isolatedCalls: Array<{ description: string; prompt: string }> = [];
    const runIsolatedTask = vi.fn(async (req: any) => {
      isolatedCalls.push({ description: req.description, prompt: req.prompt });
      return { success: true, output: "attempted a fix" };
    });
    const ctx = makeCtx({ runIsolatedTask, sessionModelId: "fixer-model" });

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(error).toBeUndefined();

    // Blocker #1 — the check ran despite verify being a straight FAIL (the
    // floor never ran: verifyVerdict never reached PASS/UNKNOWN).
    expect(checkProjectRegistration).toHaveBeenCalled();

    // The S4 loop must have triggered a fix round FOR THIS REASON.
    const fixRounds = isolatedCalls.filter((c) => c.description.includes("verify-fix"));
    expect(fixRounds.length).toBeGreaterThan(0);
    expect(fixRounds[0]!.prompt).toContain("Register `src/src/Acme.Widgets/Acme.Widgets.csproj` in `Acme.sln`");

    // And the same text survives into the next sprint's carry-over focus.
    expect(result?.nextFocus).toContain("Register `src/src/Acme.Widgets/Acme.Widgets.csproj` in `Acme.sln`");
  });

  it("verify PASSes with real coverage: the check still triggers a fix round and clears once registered (S6's own PASS-path contract, unchanged)", async () => {
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
    (checkProjectRegistration as any)
      .mockResolvedValueOnce(VIOLATING_RESULT) // Step 5's first pass
      .mockResolvedValue(CLEAN_RESULT); // every S4 re-verify pass after the fixer "ran"

    const runIsolatedTask = vi.fn(async () => ({ success: true, output: "registered it" }));
    const ctx = makeCtx({ runIsolatedTask, sessionModelId: "fixer-model" });

    const { result, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(error).toBeUndefined();
    expect(checkProjectRegistration).toHaveBeenCalled();
    expect(runIsolatedTask).toHaveBeenCalled();
    expect(result?.lastVerifyResult).toBe("PASS");
  });
});
