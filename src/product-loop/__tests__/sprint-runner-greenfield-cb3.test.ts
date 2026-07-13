/**
 * sprint-runner-greenfield-cb3.test.ts
 *
 * Task #8 — greenfield build-first. On a fresh greenfield /ideal run, sprint 1
 * has nothing to verify yet: detectVerifyRecipe legitimately returns null (the
 * code + tests don't exist until this sprint BUILDS them). CB-3 must NOT halt in
 * that case — it would trap every greenfield idea before a line is written.
 * Instead the run proceeds to build; the verify stage re-detects the recipe from
 * the code it creates. The CB-3 halt is preserved for EXISTING projects.
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
  // Real CB-3 would halt on a null recipe; force it so the greenfield bypass is
  // the ONLY thing that can prevent the halt.
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
    createdAtMs: 0,
  })),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

// The knob under test: greenfield vs existing classification comes from the
// persisted ProjectContext.
const classification = { value: "greenfield" as "greenfield" | "existing" };
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => ({
    idea: "greenfield idea",
    detection: { classification: classification.value },
    context: {},
  })),
}));

import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let testFlowDir = "/tmp/flow";
beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-greenfield-"));
  vi.clearAllMocks();
  classification.value = "greenfield";
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
  };
}

function makeCtx(): unknown {
  return {
    runId: "run-greenfield",
    flowDir: testFlowDir,
    cwd: "/tmp/cwd",
    idea: "greenfield idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "impl" };
    }),
    // No recipe — nothing is built yet on a greenfield sprint 1.
    detectVerifyRecipe: async () => null,
  };
}

// Collect chunks, swallowing any error from downstream stages (planning /
// implement / verify) that this test intentionally does NOT fully mock — the
// greenfield bypass emits the chunks we assert on BEFORE any such stage runs.
async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<T[]> {
  const chunks: T[] = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return chunks;
      chunks.push(value as T);
    }
  } catch {
    return chunks;
  }
}

describe("runSprint CB-3 — greenfield build-first (Task #8)", () => {
  it("does NOT halt on a greenfield sprint 1 with no recipe — proceeds to build", async () => {
    const chunks = (await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    )) as Array<{ type?: string; content?: string }>;

    // No CB-3 halt chunk — the greenfield idea is allowed to build.
    expect(chunks.find((c) => c.type === "halt")).toBeUndefined();
    // The build-first notice was surfaced.
    expect(chunks.some((c) => c.type === "content" && (c.content ?? "").includes("Greenfield"))).toBe(true);
    // It got past CB-3 into the planning stage.
    expect(chunks.some((c) => c.type === "content" && (c.content ?? "").includes("Planning"))).toBe(true);
  });

  it("still halts on an EXISTING project with no recipe (recovery card preserved)", async () => {
    classification.value = "existing";
    const chunks = (await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    )) as Array<{ type?: string }>;

    expect(chunks.find((c) => c.type === "halt")).toBeTruthy();
  });
});
