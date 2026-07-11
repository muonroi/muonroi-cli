/**
 * sprint-runner-phase-chunks.test.ts — P4-E unit tests.
 *
 * Phase 4 (UX): verify runSprint yields council_phase chunks for each sprint
 * stage so the TUI's CouncilPhaseTimeline shows live progress instead of going
 * silent for minutes during the planning council / implementation tool loop.
 *
 * Asserts:
 *   1. 4 phase pairs (start+done) emitted per healthy sprint
 *      (planning, implementation, verification, judgment)
 *   2. Each "active" event carries a numeric startedAt (drives live elapsed)
 *   3. phaseId is stable & unique per stage (so upsertPhase replaces in place)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(),
}));
vi.mock("../../verify/orchestrator.js", () => ({
  runVerifyOrchestration: vi.fn(),
}));
vi.mock("../done-gate.js", () => ({
  evaluateDoneGate: vi.fn(),
}));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
}));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({
  postSprintBoundary: vi.fn(async () => undefined),
}));
vi.mock("../role-memory.js", () => ({
  appendRoleMemory: vi.fn(async () => undefined),
}));
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
vi.mock("../../providers/runtime.js", () => ({
  detectProviderForModel: vi.fn(() => "anthropic"),
}));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

// Per-test isolated flow dir — see sprint-runner.test.ts for the rationale.
let testFlowDir = "/tmp/flow";

beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-phase-"));
});
afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

function makeCtx(): unknown {
  return {
    runId: "run-test-phase",
    flowDir: testFlowDir,
    cwd: "/tmp/cwd",
    idea: "test idea",
    llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({
      testCommands: ["npm test"],
      coverage: 80,
      shellInitCommands: [],
    })),
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
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<T[]> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return chunks;
    chunks.push(value as T);
  }
}

describe("sprint-runner emit — council_phase chunks (P4-E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CB3_verifyBlank as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ halt: false });
    (evaluateDoneGate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ pass: true, score: 1.0 });
    (runVerifyOrchestration as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text";
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
  });

  it("emits 4 active phase chunks (planning, implementation, verification, judgment) with stable phaseIds and startedAt", async () => {
    const chunks = await drain(
      runSprint({
        sprintN: 1,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    );

    const phaseChunks = chunks.filter(
      (c) =>
        (c as unknown as Record<string, unknown>).type === "council_phase" &&
        (c as unknown as { councilPhase?: { kind?: string } }).councilPhase?.kind === "sprint_stage",
    );
    const actives = phaseChunks
      .map((c) => (c as unknown as { councilPhase: Record<string, unknown> }).councilPhase)
      .filter((p) => p.state === "active");

    expect(actives).toHaveLength(4);

    const ids = actives.map((p) => p.phaseId as string).sort();
    expect(ids).toEqual(["sprint-1-implementation", "sprint-1-judgment", "sprint-1-planning", "sprint-1-verification"]);

    for (const p of actives) {
      expect(typeof p.startedAt).toBe("number");
      expect(p.startedAt as number).toBeGreaterThan(0);
      expect(typeof p.label).toBe("string");
      expect((p.label as string).startsWith("Sprint 1 — ")).toBe(true);
    }
  });

  it("emits matching done chunks after each active, in correct order", async () => {
    const chunks = await drain(
      runSprint({
        sprintN: 2,
        ctx: makeCtx() as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }),
    );
    const sprintPhases = chunks
      .filter(
        (c) =>
          (c as unknown as Record<string, unknown>).type === "council_phase" &&
          (c as unknown as { councilPhase?: { kind?: string } }).councilPhase?.kind === "sprint_stage",
      )
      .map((c) => (c as unknown as { councilPhase: Record<string, unknown> }).councilPhase);

    // Each phaseId should appear exactly twice (active + done), in that order.
    const seqByPhase = new Map<string, string[]>();
    for (const p of sprintPhases) {
      const arr = seqByPhase.get(p.phaseId as string) ?? [];
      arr.push(p.state as string);
      seqByPhase.set(p.phaseId as string, arr);
    }
    for (const [id, seq] of seqByPhase.entries()) {
      expect(seq).toEqual(["active", "done"]);
      expect(id.startsWith("sprint-2-")).toBe(true);
    }
    expect(seqByPhase.size).toBe(4);
  });
});

describe("phase-events helper (P4-B)", () => {
  it("phaseStart auto-populates startedAt with current time", async () => {
    const { phaseStart } = await import("../../council/phase-events.js");
    const before = Date.now();
    const chunk = phaseStart({ phaseId: "x", kind: "sprint_stage", label: "L" });
    const after = Date.now();
    expect(chunk.type).toBe("council_phase");
    expect(chunk.councilPhase?.startedAt).toBeGreaterThanOrEqual(before);
    expect(chunk.councilPhase?.startedAt).toBeLessThanOrEqual(after);
  });

  it("phaseStart respects explicit startedAt override (for deterministic tests)", async () => {
    const { phaseStart } = await import("../../council/phase-events.js");
    const chunk = phaseStart({ phaseId: "x", kind: "sprint_stage", label: "L", startedAt: 12345 });
    expect(chunk.councilPhase?.startedAt).toBe(12345);
  });
});
