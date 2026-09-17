import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All external modules are mocked so the test exercises only sprint-runner orchestration.
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
  recordProductSpend: vi.fn(async () => undefined),
}));
vi.mock("../../providers/runtime.js", () => ({
  detectProviderForModel: vi.fn(() => "anthropic"),
}));

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { appendIteration } from "../artifact-io.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { recordProductSpend } from "../cost-scoper.js";
import { evaluateDoneGate } from "../done-gate.js";
import { postSprintBoundary } from "../phase-tracker-bridge.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState, ProductSpec, RoleSlot } from "../types.js";
import { verifyBaselinePath } from "../verify-baseline.js";
import { captureVerifyFloorBaseline } from "../verify-floor.js";

// Per-test isolated flow dir. sprint-runner does REAL filesystem persistence of
// per-sprint plans (persistSprintPlan/readPersistedSprintPlan live in the module
// under test, so they can't be mocked). A shared "/tmp/flow" + fixed runId let a
// plan persisted by one test be read back by a later test with the same
// runId+sprintN — which silently skips the planning council (reused-plan path),
// so runCouncil is never called and the assertions here fail. A fresh mkdtemp dir
// per test keeps each run hermetic regardless of order or leftover files.
let testFlowDir = "/tmp/flow";

function makeCtx(overrides: any = {}): any {
  return {
    runId: "run-123",
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
    sprintEstimate: 2,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

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

beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-runner-"));
});
afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

describe("sprint-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
    (CB3_verifyBlank as any).mockReturnValue({ halt: false });
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as any).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text from council";
    });
  });

  it("happy path: plan → implement → verify → judge → return passing IterationState", async () => {
    const ctx = makeCtx();
    const gen = runSprint({
      sprintN: 1,
      ctx,
      productSpec: makeSpec(),
      roleAssignments: NO_ROLES,
      history: [],
    });

    const { chunks, result } = await drain(gen);
    expect(result).toBeDefined();
    expect(result!.sprintN).toBe(1);
    expect(result!.scoreAfter).toBe(1.0);
    expect(result!.lastVerifyResult).toBe("PASS");
    expect(result!.stage).toBe("shipped");

    expect(runCouncil).toHaveBeenCalledTimes(1);
    expect(ctx.processMessageFn).toHaveBeenCalled(); // implementation step
    expect(runVerifyOrchestration).toHaveBeenCalledTimes(1);
    expect(evaluateDoneGate).toHaveBeenCalledTimes(1);
    expect(appendIteration).toHaveBeenCalledTimes(1);
    expect(postSprintBoundary).toHaveBeenCalledWith(expect.objectContaining({ outcome: "pass", sprintN: 1 }));
    expect(chunks.some((c: any) => c.type === "content")).toBe(true);
  });

  it("does NOT spawn a repair turn for a plan-DEFERRED target — loop advances to verify (regression: run mrq8mesr0389)", async () => {
    const realCwd = mkdtempSync(join(tmpdir(), "sprint-cwd-"));
    try {
      // Council plan NAMES a required file (src/feature.ts) AND a POST-MVP /
      // DEFERRED file (packages/x/module-hook.ts) it deliberately does NOT build
      // this sprint — the exact shape that wedged run mrq8mesr0389.
      const deferredPlan = [
        '"folderStructure": "src/feature.ts; packages/x/module-hook.ts",',
        '{ "step": "Implement src/feature.ts this sprint" },',
        "{",
        '  "name": "moduleHook.install() [POST-MVP]",',
        '  "location": "packages/x/module-hook.ts",',
        '  "contract": "DEFERRED: only after benchmark"',
        "}",
      ].join("\n");
      (runCouncil as any).mockImplementation(async function* () {
        yield { type: "content", content: "planning..." };
        return deferredPlan;
      });
      // Faithful implementer: creates ONLY the required file, honoring the
      // deferral. module-hook.ts is left absent on purpose.
      const processMessageFn = vi.fn(async function* () {
        mkdirSync(join(realCwd, "src"), { recursive: true });
        writeFileSync(join(realCwd, "src/feature.ts"), "export const f = 1;\n");
        yield { type: "content", content: "implemented src/feature.ts" };
      });
      const ctx = makeCtx({ cwd: realCwd, processMessageFn });

      const { result, error } = await drain(
        runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
      );

      // No wedge: the loop completed to a shipped IterationState.
      expect(error).toBeUndefined();
      expect(result?.stage).toBe("shipped");
      // The DEFERRED file was NEVER force-created by a repair turn.
      expect(existsSync(join(realCwd, "packages/x/module-hook.ts"))).toBe(false);
      // EXACTLY one impl turn. Before the fix, the absent (deferred) module-hook.ts
      // registered as a "missing target" → a 2nd (repair) processMessageFn turn.
      expect(processMessageFn).toHaveBeenCalledTimes(1);
      // Loop advanced past implementation into verification.
      expect(runVerifyOrchestration).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(realCwd, { recursive: true, force: true });
    }
  });

  it("MUONROI_SPRINT_SKIP_VERIFY=1 bypasses the verify stage (A skip-verify recovery)", async () => {
    process.env.MUONROI_SPRINT_SKIP_VERIFY = "1";
    try {
      const ctx = makeCtx();
      const { chunks, result } = await drain(
        runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
      );
      // Verify orchestration must NOT run when the bypass flag is set.
      expect(runVerifyOrchestration).not.toHaveBeenCalled();
      // Sprint still completes (verify treated as PASS) and emits the bypass note.
      expect(result).toBeDefined();
      expect(result!.lastVerifyResult).toBe("PASS");
      const text = chunks.map((c: any) => c.content ?? "").join("");
      expect(text).toContain("[skip-verify]");
    } finally {
      delete process.env.MUONROI_SPRINT_SKIP_VERIFY;
    }
  });

  it("CB-3 trips on sprint 1 with missing recipe — yields halt chunk BEFORE planner runs", async () => {
    (CB3_verifyBlank as any).mockReturnValue({ halt: true, reason: "no_recipe" });
    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });
    const { chunks, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    // Must yield a structured halt chunk, not throw.
    expect(error).toBeUndefined();
    const haltChunks = chunks.filter((c: any) => c.type === "halt");
    expect(haltChunks).toHaveLength(1);
    expect(haltChunks[0]).toMatchObject({
      type: "halt",
      haltChunk: {
        reason: "no_recipe",
        recovery_options: expect.arrayContaining([
          expect.objectContaining({ id: "init_new" }),
          expect.objectContaining({ id: "point_to_existing" }),
          expect.objectContaining({ id: "continue_as_council" }),
        ]),
      },
    });
    expect((haltChunks[0] as any).haltChunk.recovery_options).toHaveLength(3);
    expect(runCouncil).not.toHaveBeenCalled();
    expect(runVerifyOrchestration).not.toHaveBeenCalled();
  });

  // The skipped "CB-1 trips when projected cost exceeds 1.5x remaining headroom"
  // test is gone: CB-1 was deleted, not just disabled, with `/ideal`'s spend cap
  // (user decision: no limits), so there is nothing left to re-enable.

  it("CB-2 trips when last 2 deltas are non-positive at sprint >= 3", async () => {
    (CB2_oscillation as any).mockReturnValue({ halt: true, delta_t: -0.05, delta_t_minus_1: 0 });
    (evaluateDoneGate as any).mockResolvedValue({ pass: false, failedCondition: "weighted_score", score: 0.4 });

    const history: IterationState[] = [
      {
        sprintN: 3,
        stage: "retrospective",
        scoreBefore: 0.5,
        scoreAfter: 0.5,
        criteriaMet: 0,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      },
      {
        sprintN: 4,
        stage: "retrospective",
        scoreBefore: 0.5,
        scoreAfter: 0.5,
        criteriaMet: 0,
        criteriaPartial: 0,
        criteriaUnmet: 0,
        costUsd: 0,
        lastVerifyResult: "PASS",
      },
    ];
    const ctx = makeCtx();
    const { error } = await drain(
      runSprint({ sprintN: 5, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history }),
    );
    expect((error as Error).message).toContain("oscillation");
  });

  it("Done-gate Cond #1 fail: returns IterationState with verify-result and continue-feedback chunk emitted", async () => {
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      score: 0.4,
      reason: "verify_FAIL",
    });
    (runVerifyOrchestration as any).mockResolvedValue({
      success: false,
      output: "VERIFY_FAIL\nTests failed",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });

    const ctx = makeCtx();
    const { chunks, result } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(result!.stage).toBe("retrospective");
    expect(result!.lastVerifyResult).toBe("FAIL");
    const continueChunk = chunks.find((c: any) => typeof c.content === "string" && c.content.includes("Next focus"));
    expect(continueChunk).toBeDefined();
    // Task #10: the not-done sprint returns a carry-over focus so the phase-runner
    // adapter can thread it into the next sprint (continue the risky/failing parts).
    expect(result!.nextFocus).toBeDefined();
    expect(result!.nextFocus).toContain("fix verify failures");
  });

  it("S5 — a run-introduced build break the verify floor cannot excuse carries into nextFocus as a must-fix item", async () => {
    // Real git repo + real `npm run build`, replaying the mu54vrme4c87 shape:
    // a baseline captured DIRTY (an earlier run's leftover breakage) whose
    // build was already red, then THIS run's own edit introduces a DIFFERENT
    // build error on top of it. The old binary buildOk===false rule excused
    // this unconditionally; it must not anymore.
    const realCwd = mkdtempSync(join(tmpdir(), "sprint-s5-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: realCwd, stdio: "ignore" });
      const writeBuildCfg = (code: string, message: string) =>
        writeFileSync(join(realCwd, "buildcfg.json"), JSON.stringify({ code, message }), "utf8");

      writeFileSync(
        join(realCwd, "package.json"),
        JSON.stringify({
          name: "s5-sprint-fixture",
          version: "0.0.0",
          private: true,
          scripts: { build: "node build.js" },
        }),
        "utf8",
      );
      writeFileSync(
        join(realCwd, "build.js"),
        [
          "const fs = require('fs');",
          "const path = require('path');",
          "const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'buildcfg.json'), 'utf8'));",
          "console.error('error ' + cfg.code + ': ' + cfg.message);",
          "process.exit(1);",
        ].join("\n"),
        "utf8",
      );
      writeBuildCfg("CS0103", "legacy baseline issue in Legacy.cs");
      writeFileSync(join(realCwd, "README.md"), "seed\n", "utf8");

      git("init", "-q", "-b", "main");
      git("config", "user.email", "s5@test.local");
      git("config", "user.name", "S5 fixture");
      git("config", "commit.gpgsign", "false");
      git("add", "-A");
      git("commit", "-q", "-m", "seed");

      // Dirty an unrelated file BEFORE capturing the baseline, so the baseline
      // is itself dirty (like mu54vrme4c87) — this run must not inherit its
      // "not this run's doing" pass just because the tree was already dirty.
      writeFileSync(join(realCwd, "README.md"), "seed\ndirty\n", "utf8");

      const ctx = makeCtx({ cwd: realCwd });
      await captureVerifyFloorBaseline({
        cwd: realCwd,
        runId: ctx.runId,
        baselinePath: verifyBaselinePath(ctx.flowDir, ctx.runId),
      });

      // This run's own edit: a NEW build error the baseline never saw, in a
      // file (buildcfg.json) the baseline itself never recorded as dirty.
      writeBuildCfg("NU1107", "Version conflict detected for Sample.CodeAnalysis in Directory.Packages.props");

      (evaluateDoneGate as any).mockResolvedValue({
        pass: false,
        failedCondition: "engineering_floor",
        score: 0,
        reason: "verify_floor_FAIL",
      });
      // runVerifyOrchestration keeps the module-level PASS mock (beforeEach) so
      // the deterministic floor actually runs and gets to decide the verdict.

      const { result } = await drain(
        runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
      );

      expect(result!.lastVerifyResult).toBe("FAIL");
      expect(result!.nextFocus).toBeDefined();
      expect(result!.nextFocus).toContain("Build gate");
      expect(result!.nextFocus).toContain("this run introduced its own break");
      expect(result!.nextFocus).toContain("Fix it before the next sprint can be verified.");
    } finally {
      rmSync(realCwd, { recursive: true, force: true });
    }
  });

  // Previously: "releases reservation when council generate throws" and "propagates
  // CapBreachError as readable Error from product-LLM wrapper". `/ideal` has no
  // spend cap (user decision): the wrapper reserves nothing and refuses nothing; it
  // records the spend after each call returns.
  it("the product-LLM wrapper meters every call and never refuses one on spend", async () => {
    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _model: string,
      _msgs: any,
      _sid: string,
      llm: any,
    ) {
      yield { type: "content", content: "planning" };
      const text = await llm.generate("m", "sys", "prompt");
      return `plan: ${text}`;
    });

    const ctx = makeCtx();
    const { error, result } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    expect(ctx.llm.generate).toHaveBeenCalled();
    expect(recordProductSpend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "m" }),
      "run-123",
      expect.objectContaining({ callsite: "sprint.generate" }),
    );
  });
});

describe("sprint-runner phaseScope (subsystem E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
    (CB3_verifyBlank as any).mockReturnValue({ halt: false });
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as any).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text from council";
    });
  });

  it("when phaseScope present, evaluateDoneGate receives only the scoped subset of criteria", async () => {
    // Arrange: readCriteria returns 3 criteria; phaseScope restricts to 2 of them.
    const { readCriteria } = await import("../artifact-io.js");
    (readCriteria as any).mockResolvedValue([
      { id: "crit-A", status: "met" },
      { id: "crit-B", status: "unmet" },
      { id: "crit-C", status: "partial" },
    ]);
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });

    const ctx = makeCtx();
    const { result } = await drain(
      runSprint({
        sprintN: 1,
        ctx,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
        phaseScope: { criteria: ["crit-A", "crit-B"], scope: "phase-1" },
      }),
    );

    expect(result).toBeDefined();
    // evaluateDoneGate must have been called with only the 2 scoped criteria, not all 3.
    const gateCall = (evaluateDoneGate as any).mock.calls[0][0];
    expect(gateCall.criteria).toHaveLength(2);
    expect(gateCall.criteria.map((c: any) => c.id)).toEqual(["crit-A", "crit-B"]);
  });

  it("when phaseScope criteria don't match any Criterion.id, falls back to full set", async () => {
    // Arrange: readCriteria returns 3 criteria with slug ids.
    // phaseScope.criteria contains verbatim spec text that doesn't match any id.
    const { readCriteria } = await import("../artifact-io.js");
    (readCriteria as any).mockResolvedValue([
      { id: "crit-A", status: "met" },
      { id: "crit-B", status: "unmet" },
      { id: "crit-C", status: "partial" },
    ]);
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });

    const ctx = makeCtx();
    await drain(
      runSprint({
        sprintN: 1,
        ctx,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
        phaseScope: {
          criteria: ["All API endpoints return 200", "Database migrations complete"],
          scope: "phase-1",
        },
      }),
    );

    // None of the verbatim strings match slug ids → permissive fallback → all 3 passed.
    const gateCall = (evaluateDoneGate as any).mock.calls[0][0];
    expect(gateCall.criteria).toHaveLength(3);
  });

  it("when phaseScope is absent, evaluateDoneGate receives all criteria (backwards-compat)", async () => {
    const { readCriteria } = await import("../artifact-io.js");
    (readCriteria as any).mockResolvedValue([
      { id: "crit-A", status: "met" },
      { id: "crit-B", status: "unmet" },
      { id: "crit-C", status: "partial" },
    ]);
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });

    const ctx = makeCtx();
    await drain(runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }));

    const gateCall = (evaluateDoneGate as any).mock.calls[0][0];
    expect(gateCall.criteria).toHaveLength(3);
  });
});

// ── Task 5.1: call-site halt forwarding ─────────────────────────────────────
// These tests exercise runSprint() directly (the only unit-testable path for the
// halt chunk shape and forwarding semantics). The call-site logic in index.ts
// (sites 1, 2, 3) uses the same discriminator pattern; testing the yielded shape
// here proves the contract that all three sites consume.

describe("sprint-runner halt chunk forwarding (Task 5.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
    (CB3_verifyBlank as any).mockReturnValue({ halt: false });
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
    (runVerifyOrchestration as any).mockResolvedValue({
      success: true,
      output: "VERIFY_PASS\n",
      verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
    });
    (runCouncil as any).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text from council";
    });
  });

  it("call site 1 pattern — CB-3 halt chunk is yielded (not thrown) and contains 3 recovery options", async () => {
    // Simulate what site 1 (runOneSprint) drives: runSprint with sprintN=1, no history.
    (CB3_verifyBlank as any).mockReturnValue({ halt: true, reason: "no_recipe" });
    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });

    const { chunks, error } = await drain(
      runSprint({ sprintN: 1, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    // No throw — error must be undefined.
    expect(error).toBeUndefined();
    // Halt chunk must be in the yielded stream.
    const halt = chunks.find((c: any) => c.type === "halt");
    expect(halt).toBeDefined();
    expect(halt).toMatchObject({ type: "halt", haltChunk: { reason: "no_recipe" } });
    expect((halt as any).haltChunk.recovery_options).toHaveLength(3);
    // Planner and verifier must NOT have run.
    expect(runCouncil).not.toHaveBeenCalled();
    expect(runVerifyOrchestration).not.toHaveBeenCalled();
  });

  it("call site 2 pattern — CB-3 halt chunk is forwarded through multi-sprint drainSprints loop", async () => {
    // Simulate what site 2 (drainSprints) drives: runSprint with sprintN >= 1, history may be non-empty.
    (CB3_verifyBlank as any).mockReturnValue({ halt: true, reason: "no_recipe" });
    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });

    // Drive with sprintN=2 to exercise the multi-sprint path in drainSprints.
    const { chunks, error } = await drain(
      runSprint({ sprintN: 2, ctx, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(error).toBeUndefined();
    const halt = chunks.find((c: any) => c.type === "halt");
    expect(halt).toBeDefined();
    expect(halt).toMatchObject({ type: "halt", haltChunk: { reason: "no_recipe" } });
    expect((halt as any).haltChunk.recovery_options).toHaveLength(3);
  });

  it("call site 3 pattern — CB-3 halt chunk is forwarded through phase-runner sprintRunner adapter", async () => {
    // Simulate what site 3 (sprintRunner adapter inside runWithPhases) drives:
    // runSprint called with phaseScope, no try/catch in the adapter.
    (CB3_verifyBlank as any).mockReturnValue({ halt: true, reason: "no_recipe" });
    const ctx = makeCtx({ detectVerifyRecipe: vi.fn(async () => null) });

    const { chunks, error } = await drain(
      runSprint({
        sprintN: 1,
        ctx,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
        phaseScope: { criteria: ["crit-A"], scope: "phase-1" },
      }),
    );

    // Without the fix, the generator returned normally (halt silently consumed).
    // With the fix, the halt chunk is in the yielded stream.
    expect(error).toBeUndefined();
    const halt = chunks.find((c: any) => c.type === "halt");
    expect(halt).toBeDefined();
    expect(halt).toMatchObject({ type: "halt", haltChunk: { reason: "no_recipe" } });
    expect((halt as any).haltChunk.recovery_options).toHaveLength(3);
    // Planner must NOT have been called.
    expect(runCouncil).not.toHaveBeenCalled();
  });
});
