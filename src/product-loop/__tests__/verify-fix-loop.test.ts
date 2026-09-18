import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk, TaskRequest, ToolResult, VerifyRecipe } from "../../types/index.js";
import type { FloorDelta } from "../verify-baseline.js";
import {
  computeFailureKey,
  computeVerifyFixTrigger,
  DEFAULT_VERIFY_FIX_DEADLINE_MS,
  DEFAULT_VERIFY_FIX_ROUNDS,
  deriveFailureIdentity,
  type FloorRecheckOutcome,
  getVerifyFixDeadlineMs,
  getVerifyFixRoundLimit,
  isCheapRecheckEligible,
  isCheapRecheckEnabled,
  isFailureKeyUndecidable,
  type RunVerifyFixLoopArgs,
  runVerifyFixLoop,
  type VerifyPassOutcome,
} from "../verify-fix-loop.js";
import type { FloorCheck } from "../verify-floor.js";

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<T> {
  while (true) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

function recipe(overrides: Partial<VerifyRecipe> = {}): VerifyRecipe {
  return {
    ecosystem: "node",
    appKind: "cli",
    appLabel: "app",
    shellInitCommands: [],
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: [],
    testCommands: ["npm test"],
    smokeKind: "none",
    evidence: [],
    notes: [],
    coverage: 80,
    ...overrides,
  };
}

function outcome(overrides: Partial<VerifyPassOutcome> & Pick<VerifyPassOutcome, "verifyVerdict">): VerifyPassOutcome {
  return {
    verifyResult: { success: overrides.verifyVerdict === "PASS", output: "verify output" },
    recipeFromVerify: recipe(),
    ...overrides,
  };
}

const buildFailedFloor: FloorDelta = {
  verdict: "fail",
  failureKind: "build-failed",
  failedCommand: "dotnet build",
  newlyFailing: [],
  preExisting: [],
  fixed: [],
  buildAlreadyBroken: true,
  buildAttribution: "run-introduced",
  rule: "delta",
  runIdVerified: true,
};

const preExistingBuildFloor: FloorDelta = {
  ...buildFailedFloor,
  buildAttribution: "pre-existing",
};

function testRegressionFloor(newlyFailing: string[]): FloorDelta {
  return {
    verdict: "fail",
    failureKind: "test-regression",
    failedCommand: "npm test",
    newlyFailing,
    preExisting: [],
    fixed: [],
    buildAlreadyBroken: false,
    rule: "delta",
    runIdVerified: true,
  };
}

const passingFloor: FloorDelta = {
  verdict: "pass",
  newlyFailing: [],
  preExisting: [],
  fixed: [],
  buildAlreadyBroken: false,
  rule: "delta",
  runIdVerified: true,
};

function buildCheck(overrides: Partial<FloorCheck> = {}): FloorCheck {
  return {
    kind: "build",
    command: "dotnet build",
    exitCode: 1,
    ok: false,
    timedOut: false,
    outputTail: "",
    elapsedMs: 100,
    errorSet: [],
    ...overrides,
  };
}

/** A `runFloorRecheck` stub that returns a fixed sequence of outcomes, one per call. */
function sequenceFloorRecheck(...outcomes: FloorRecheckOutcome[]): {
  fn: (roundLabel: string) => Promise<FloorRecheckOutcome>;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  async function fn(roundLabel: string): Promise<FloorRecheckOutcome> {
    calls.push(roundLabel);
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    return next;
  }
  return { fn, calls };
}

const noopArgsBase: Omit<RunVerifyFixLoopArgs, "initial" | "runVerifyPass"> = {
  sprintN: 1,
  planSynthesis: "the approved plan",
  openTasks: ["[step1] wire up the widget"],
  fixModelId: "fix-model",
};

/** A `runVerifyPass` stub that returns a fixed sequence of outcomes, one per call. */
function sequencePass(...outcomes: VerifyPassOutcome[]): {
  fn: (roundLabel: string) => AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown>;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
  async function* gen(roundLabel: string): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
    calls.push(roundLabel);
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    return next;
  }
  return { fn: gen, calls };
}

describe("getVerifyFixRoundLimit", () => {
  const KEY = "MUONROI_IDEAL_VERIFY_FIX_ROUNDS";
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it("defaults to 2 when unset", () => {
    delete process.env[KEY];
    expect(getVerifyFixRoundLimit()).toBe(DEFAULT_VERIFY_FIX_ROUNDS);
    expect(DEFAULT_VERIFY_FIX_ROUNDS).toBe(2);
  });

  it("0 disables the loop", () => {
    process.env[KEY] = "0";
    expect(getVerifyFixRoundLimit()).toBe(0);
  });

  it("honours an explicit positive integer", () => {
    process.env[KEY] = "5";
    expect(getVerifyFixRoundLimit()).toBe(5);
  });

  it("falls back to the default (logged) on an invalid value", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.env[KEY] = "-1";
      expect(getVerifyFixRoundLimit()).toBe(DEFAULT_VERIFY_FIX_ROUNDS);
      process.env[KEY] = "abc";
      expect(getVerifyFixRoundLimit()).toBe(DEFAULT_VERIFY_FIX_ROUNDS);
      process.env[KEY] = "1.5";
      expect(getVerifyFixRoundLimit()).toBe(DEFAULT_VERIFY_FIX_ROUNDS);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("computeVerifyFixTrigger / deriveFailureIdentity / computeFailureKey", () => {
  it("triggers on a run-introduced build failure", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      recipe: recipe(),
      verifyOutput: "NU1107 conflict",
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.reason).toBe("build_run_introduced");
  });

  it("skips a build failure the floor could only call pre-existing", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: preExistingBuildFloor,
      recipe: recipe(),
      verifyOutput: "NU1107 conflict",
    });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBe("pre_existing_build_only");
  });

  it("triggers on a test regression", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["MyTests.Foo"]),
      recipe: recipe(),
      verifyOutput: "1 failing",
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.reason).toBe("test_regression");
  });

  it("triggers on zero coverage even when verify itself PASSED", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ testCommands: ["dotnet test"], coverage: 0 }),
      verifyOutput: "",
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.reason).toBe("zero_coverage");
  });

  it("does not trigger on a clean PASS with real coverage", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ testCommands: ["npm test"], coverage: 80 }),
      verifyOutput: "",
    });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBeUndefined();
  });

  it("triggers on an actionable verify FAIL with no floor evidence", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      recipe: recipe(),
      verifyOutput: "assertion failed at line 12",
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.reason).toBe("FAIL");
  });

  it("does not trigger on FAIL with empty output (nothing actionable)", () => {
    const r = computeVerifyFixTrigger({ verifyVerdict: "FAIL", recipe: recipe(), verifyOutput: "   " });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBe("not_actionable");
  });

  it("does not trigger on infra failures (spawn error / timeout — nothing a code fixer can act on)", () => {
    const infra: FloorDelta = {
      verdict: "fail",
      failureKind: "infra",
      failedCommand: "npm test",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: false,
      rule: "absolute",
      runIdVerified: true,
    };
    const r = computeVerifyFixTrigger({
      verifyVerdict: "ERROR",
      floorDelta: infra,
      recipe: recipe(),
      verifyOutput: "",
    });
    expect(r.shouldRun).toBe(false);
  });

  it("computeFailureKey is stable regardless of errorSet input order", () => {
    const a = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["b", "a"]),
      recipe: recipe(),
      verifyOutput: "",
    });
    const b = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["a", "b"]),
      recipe: recipe(),
      verifyOutput: "",
    });
    expect(computeFailureKey(a)).toBe(computeFailureKey(b));
  });

  it("computeFailureKey differs when the newly-failing set differs", () => {
    const a = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["a"]),
      recipe: recipe(),
      verifyOutput: "",
    });
    const b = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["b"]),
      recipe: recipe(),
      verifyOutput: "",
    });
    expect(computeFailureKey(a)).not.toBe(computeFailureKey(b));
  });
});

describe("runVerifyFixLoop", () => {
  it("FAIL then the fix works: re-verify passes, judgment sees the pass", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass } = sequencePass(fixed);
    const fixerCalls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      fixerCalls.push(req);
      return { success: true, output: "applied the fix" };
    };

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(result.enabled).toBe(true);
    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("pass");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].verifyVerdictAfter).toBe("PASS");
    expect(result.final.verifyVerdict).toBe("PASS");
    expect(fixerCalls).toHaveLength(1);
    expect(fixerCalls[0].modelId).toBe("fix-model");
  });

  it("FAIL with the same error set twice: stopReason is no_progress after round 1", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    const stillFailing = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    const { fn: runVerifyPass } = sequencePass(stillFailing);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 5 }),
    );

    expect(result.stopReason).toBe("no_progress");
    expect(result.rounds).toHaveLength(1);
  });

  it("reaches the round cap when the failure keeps changing without ever passing", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.A"]) });
    const round1 = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.B"]) });
    const round2 = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.C"]) });
    const { fn: runVerifyPass } = sequencePass(round1, round2);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(result.stopReason).toBe("round_cap");
    expect(result.rounds).toHaveLength(2);
  });

  it("skips a pre-existing-only build failure and records the skip", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: preExistingBuildFloor });
    let verifyPassCalls = 0;
    let fixerCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => {
      fixerCalls++;
      return { success: true, output: "" };
    };

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(result.triggered).toBe(false);
    expect(result.skippedReason).toBe("pre_existing_build_only");
    expect(result.stopReason).toBe("not_triggered");
    expect(result.rounds).toEqual([]);
    expect(verifyPassCalls).toBe(0);
    expect(fixerCalls).toBe(0);
  });

  it("MUONROI_IDEAL_VERIFY_FIX_ROUNDS=0 is byte-identical to today: nothing runs", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    let verifyPassCalls = 0;
    let fixerCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => {
      fixerCalls++;
      return { success: true, output: "" };
    };

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 0 }),
    );

    expect(result.enabled).toBe(false);
    expect(result.stopReason).toBe("disabled");
    expect(result.rounds).toEqual([]);
    expect(result.final).toBe(initial);
    expect(verifyPassCalls).toBe(0);
    expect(fixerCalls).toBe(0);
  });

  it("the fixer throws: stopReason is error and the sprint continues with the last verify", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    let verifyPassCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => {
      throw new Error("provider socket reset");
    };

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].fixerSuccess).toBe(false);
    expect(result.final).toBe(initial);
    expect(verifyPassCalls).toBe(0);
  });

  it("no isolated-task capability: stopReason is error, nothing dispatched", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      return initial;
    }
    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, initial, runVerifyPass, maxRounds: 2, runIsolatedTask: undefined }),
    );
    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.rounds).toEqual([]);
  });

  it("the zero_coverage case triggers the loop", async () => {
    const initial = outcome({
      verifyVerdict: "PASS",
      recipeFromVerify: recipe({ testCommands: ["dotnet test"], coverage: 0 }),
    });
    const fixed = outcome({
      verifyVerdict: "PASS",
      recipeFromVerify: recipe({ testCommands: ["dotnet test"], coverage: 80 }),
    });
    const { fn: runVerifyPass } = sequencePass(fixed);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "registered the project" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("pass");
    expect(result.rounds[0].failureKeyBefore).toContain("zero_coverage");
  });

  it("an already-aborted signal stops the loop before any round runs", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    let verifyPassCalls = 0;
    let fixerCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => {
      fixerCalls++;
      return { success: true, output: "" };
    };
    const controller = new AbortController();
    controller.abort();

    const result = await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 2,
        abortSignal: controller.signal,
      }),
    );

    expect(result.stopReason).toBe("aborted");
    expect(verifyPassCalls).toBe(0);
    expect(fixerCalls).toBe(0);
  });

  it("calls onRoundStart before dispatching each round's fixer", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass } = sequencePass(fixed);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "applied the fix" });
    const startedRounds: number[] = [];

    await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 2,
        onRoundStart: (round) => startedRounds.push(round),
      }),
    );

    expect(startedRounds).toEqual([1]);
  });

  it("a signal that fires AFTER round 1's fixer stops before the re-verify — no round 2, stopReason aborted, round 1 still recorded", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    const controller = new AbortController();
    let verifyPassCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return outcome({ verifyVerdict: "PASS" });
    }
    // The signal fires as a SIDE EFFECT of the fixer call resolving — exactly
    // "abort landed between the fixer and the re-verify".
    const runIsolatedTask = async (): Promise<ToolResult> => {
      controller.abort();
      return { success: true, output: "applied the fix" };
    };

    const result = await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 3,
        abortSignal: controller.signal,
      }),
    );

    expect(result.stopReason).toBe("aborted");
    expect(verifyPassCalls).toBe(0); // no re-verify, no round 2
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({ round: 1, fixerRan: true, fixerSuccess: true });
    // The record persisted to disk is built from exactly this result by
    // sprint-runner.ts, unconditionally — see the "S4 — bounded verify-fix
    // loop" describe block in sprint-runner.test.ts for the on-disk proof.
  });
});

describe("isCheapRecheckEligible", () => {
  it("is eligible for a run-introduced build failure", () => {
    const identity = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      recipe: recipe(),
      verifyOutput: "",
    });
    expect(isCheapRecheckEligible(identity)).toBe(true);
  });

  it("is NOT eligible for zero_coverage (needs the sub-agent's own recipe read)", () => {
    const identity = deriveFailureIdentity({
      verifyVerdict: "PASS",
      recipe: recipe({ testCommands: ["dotnet test"], coverage: 0 }),
      verifyOutput: "",
    });
    expect(isCheapRecheckEligible(identity)).toBe(false);
  });

  it("is NOT eligible for a plain verify_verdict failure, even with a recognizable error code", () => {
    const identity = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      recipe: recipe(),
      verifyOutput: "error TS2345: argument mismatch",
    });
    expect(identity.failedCondition).toBe("verify_verdict");
    expect(isCheapRecheckEligible(identity)).toBe(false);
  });

  it("is NOT eligible for a combined build+registration identity (needs the structure check too)", () => {
    const combined = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      recipe: recipe(),
      verifyOutput: "",
      structureCheck: {
        ecosystems: [
          {
            ecosystem: "C#",
            solutionFile: "src/Acme.sln",
            status: "violations",
            unregistered: [
              {
                manifest: "src/Acme.Widgets/Acme.Widgets.csproj",
                reason: "not referenced by src/Acme.sln",
                solutionFile: "src/Acme.sln",
              },
            ],
          },
        ],
        addedFilesSource: "git-status-fallback",
        addedFilesCount: 1,
      },
    });
    expect(combined.reason).toContain("+project_not_registered");
    expect(isCheapRecheckEligible(combined)).toBe(false);
  });
});

describe("isCheapRecheckEnabled", () => {
  const KEY = "MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it("defaults to enabled", () => {
    delete process.env[KEY];
    expect(isCheapRecheckEnabled()).toBe(true);
  });

  it("=0 disables it", () => {
    process.env[KEY] = "0";
    expect(isCheapRecheckEnabled()).toBe(false);
  });
});

describe("runVerifyFixLoop — D2 cheap deterministic re-check", () => {
  const ENV_KEY = "MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK";
  let prevEnv: string | undefined;
  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  it("round 1 fixer, build still broken: no verify sub-agent call that round, and the round is recorded as cheap", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    let verifyPassCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck({
      ranOk: true,
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 1 }),
    );

    // No verify sub-agent turn was dispatched this round — the deterministic
    // floor alone already proved nothing changed.
    expect(verifyPassCalls).toBe(0);
    expect(floorCalls).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].passKind).toBe("cheap");
    // Never fabricated: the final verdict is exactly the last one the verify
    // sub-agent actually produced (the initial one — no full pass ran).
    expect(result.final.verifyVerdict).toBe(initial.verifyVerdict);
  });

  it("round 1 fixer, build now green: a full pass runs, and the loop can pass", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck({
      ranOk: true,
      floorDelta: passingFloor,
      floorChecks: [],
    });
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "fixed the build" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 2 }),
    );

    expect(floorCalls).toHaveLength(1);
    expect(verifyCalls).toHaveLength(1);
    expect(result.stopReason).toBe("pass");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].passKind).toBe("full");
    expect(result.final.verifyVerdict).toBe("PASS");
  });

  it("no recipe: always full (verify_verdict identity is never cheap-recheck eligible)", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      recipeFromVerify: null,
      verifyResult: { success: false, output: "VERIFY_FAIL\nerror TS2345: argument mismatch" },
    });
    const fixed = outcome({ verifyVerdict: "PASS", recipeFromVerify: null });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck({ ranOk: true, floorDelta: passingFloor });
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "applied" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 2 }),
    );

    expect(floorCalls).toHaveLength(0);
    expect(verifyCalls).toHaveLength(1);
    expect(result.rounds[0].passKind).toBe("full");
  });

  it("a verify_verdict failure with an empty error set: always full", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nsomething went wrong, no code here" },
    });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck({ ranOk: true, floorDelta: passingFloor });
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "applied" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 2 }),
    );

    expect(floorCalls).toHaveLength(0);
    expect(verifyCalls).toHaveLength(1);
    expect(result.rounds[0].passKind).toBe("full");
  });

  it("MUONROI_IDEAL_VERIFY_FIX_CHEAP_RECHECK=0: always full, byte-identical to pre-D2 behaviour", async () => {
    process.env[ENV_KEY] = "0";
    const initial = outcome({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck({
      ranOk: true,
      floorDelta: passingFloor,
    });
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "fixed the build" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 2 }),
    );

    expect(floorCalls).toHaveLength(0);
    expect(verifyCalls).toHaveLength(1);
    expect(result.stopReason).toBe("pass");
    expect(result.rounds[0].passKind).toBe("full");
  });

  it("no runFloorRecheck provided: always full, same as today (the arg is optional)", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "fixed the build" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 2 }),
    );

    expect(verifyCalls).toHaveLength(1);
    expect(result.rounds[0].passKind).toBe("full");
  });

  it("the floor is not run twice in a single round: the saving is measurable — a 2-round loop where round 1 still fails deterministically calls the verify sub-agent only ONCE instead of twice", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0103"] })],
    });
    // Round 1's fix is incomplete: the floor still fails, but on a DIFFERENT
    // error than before — decidable progress, so no_progress does not fire.
    const round1StillBroken: FloorRecheckOutcome = {
      ranOk: true,
      floorDelta: buildFailedFloor,
      floorChecks: [buildCheck({ errorSet: ["CS0104"] })],
    };
    // Round 2's fix finishes the job: the floor is green.
    const round2Fixed: FloorRecheckOutcome = { ranOk: true, floorDelta: passingFloor, floorChecks: [] };
    const { fn: runFloorRecheck, calls: floorCalls } = sequenceFloorRecheck(round1StillBroken, round2Fixed);
    const fixed = outcome({ verifyVerdict: "PASS" });
    const { fn: runVerifyPass, calls: verifyCalls } = sequencePass(fixed);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    // BEFORE D2 (no runFloorRecheck wired): every round pays for a full pass.
    const before = await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass: sequencePass(fixed, fixed).fn,
        maxRounds: 2,
      }),
    );
    expect(before.rounds.filter((r) => r.passKind !== "cheap")).toHaveLength(before.rounds.length);

    // AFTER D2: round 1 is cheap-only (floor still fails), round 2 is full
    // (floor now passes) — the sub-agent is dispatched ONCE, not twice.
    const after = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, runFloorRecheck, maxRounds: 2 }),
    );

    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[0].passKind).toBe("cheap");
    expect(after.rounds[1].passKind).toBe("full");
    // Per round, exactly ONE of {floor-recheck, full pass} ran — never both —
    // so the floor itself is never invoked twice for the same round.
    expect(floorCalls).toHaveLength(2);
    expect(verifyCalls).toHaveLength(1);
    expect(after.stopReason).toBe("pass");
  });
});

describe("verify_verdict errorSet (S5 extractErrorSet + failing test names)", () => {
  it("a recognizable build/typecheck error code makes two rounds with DIFFERENT codes distinguishable — no premature no_progress", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nerror NU1107: version conflict on Foo.Bar" },
    });
    const round1 = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nerror CS0103: the name 'x' does not exist" },
    });
    const round2 = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nerror CS0103: the name 'x' does not exist" },
    });
    const { fn: runVerifyPass } = sequencePass(round1, round2);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 3 }),
    );

    // Round 1 (NU1107 -> CS0103) is a DIFFERENT decidable key: no no_progress.
    // Round 2 repeats round 1's CS0103 key exactly: no_progress fires there.
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].noProgressUndecidable).toBeUndefined();
    expect(result.rounds[1].noProgressUndecidable).toBeUndefined();
    expect(result.stopReason).toBe("no_progress");
  });

  it("plain prose with no recognizable code is UNDECIDABLE — the round cap bounds the loop instead of a false no_progress stop", async () => {
    const initial = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nsomething went wrong, no code here" },
    });
    const stillFailingProse = outcome({
      verifyVerdict: "FAIL",
      verifyResult: { success: false, output: "VERIFY_FAIL\nsomething went wrong, no code here" },
    });
    const { fn: runVerifyPass } = sequencePass(stillFailingProse, stillFailingProse, stillFailingProse);
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });

    const result = await drain(
      runVerifyFixLoop({ ...noopArgsBase, runIsolatedTask, initial, runVerifyPass, maxRounds: 3 }),
    );

    // Without the fix this would stop with "no_progress" after round 1.
    expect(result.stopReason).toBe("round_cap");
    expect(result.rounds).toHaveLength(3);
    for (const r of result.rounds) {
      expect(r.noProgressUndecidable).toBe(true);
      expect(r.failureKeyAfter).toBe("verify_verdict:FAIL:");
    }
  });

  it("isFailureKeyUndecidable is true only for an empty-errorSet verify_verdict identity", () => {
    const decidableEngineeringFloor = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: testRegressionFloor(["MyTests.Foo"]),
      recipe: recipe(),
      verifyOutput: "",
    });
    const undecidableVerdict = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      recipe: recipe(),
      verifyOutput: "plain prose, no code",
    });
    const decidableVerdict = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      recipe: recipe(),
      verifyOutput: "error TS2345: argument mismatch",
    });
    expect(isFailureKeyUndecidable(decidableEngineeringFloor)).toBe(false);
    expect(isFailureKeyUndecidable(undecidableVerdict)).toBe(true);
    expect(isFailureKeyUndecidable(decidableVerdict)).toBe(false);
  });
});

describe("getVerifyFixDeadlineMs", () => {
  const KEY = "MUONROI_IDEAL_VERIFY_FIX_DEADLINE_MS";
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it("defaults to 30 minutes when unset", () => {
    delete process.env[KEY];
    expect(getVerifyFixDeadlineMs()).toBe(DEFAULT_VERIFY_FIX_DEADLINE_MS);
    expect(DEFAULT_VERIFY_FIX_DEADLINE_MS).toBe(1_800_000);
  });

  it("honours an explicit positive integer", () => {
    process.env[KEY] = "60000";
    expect(getVerifyFixDeadlineMs()).toBe(60_000);
  });

  it("falls back to the default (logged) on an invalid value — 0 is invalid here, unlike the rounds env", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.env[KEY] = "0";
      expect(getVerifyFixDeadlineMs()).toBe(DEFAULT_VERIFY_FIX_DEADLINE_MS);
      process.env[KEY] = "-5";
      expect(getVerifyFixDeadlineMs()).toBe(DEFAULT_VERIFY_FIX_DEADLINE_MS);
      process.env[KEY] = "abc";
      expect(getVerifyFixDeadlineMs()).toBe(DEFAULT_VERIFY_FIX_DEADLINE_MS);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("runVerifyFixLoop — total-elapsed deadline", () => {
  it("with an injected clock, the deadline trips before round 2 and the result carries the last completed verify", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.A"]) });
    const round1 = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.B"]) });
    // The clock reports "past the deadline" only once round 1's re-verify has
    // actually completed — tied to a FUNCTIONAL milestone, not a call count,
    // so this test does not depend on how many times the implementation
    // happens to call `nowFn` internally.
    let round1ReVerifyDone = false;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      round1ReVerifyDone = true;
      return round1;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => ({ success: true, output: "tried a fix" });
    const nowFn = () => (round1ReVerifyDone ? 100_000 : 0);

    const result = await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 5,
        maxTotalMs: 10_000,
        nowFn,
      }),
    );

    expect(result.stopReason).toBe("deadline");
    expect(result.rounds).toHaveLength(1);
    // The last COMPLETED verify (round 1's outcome), not a half-finished one —
    // round 2 never dispatched a fixer at all.
    expect(result.final).toBe(round1);
  });

  it("a deadline that has already elapsed before round 1 stops immediately with no fixer/re-verify dispatched", async () => {
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: testRegressionFloor(["MyTests.Foo"]) });
    let verifyPassCalls = 0;
    let fixerCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return initial;
    }
    const runIsolatedTask = async (): Promise<ToolResult> => {
      fixerCalls++;
      return { success: true, output: "" };
    };

    // The FIRST call seeds `loopStartedAt`; every call after that must look
    // like time has already passed the 1ms deadline — a CONSTANT clock can
    // never show elapsed time relative to its own seed, so this steps once.
    let calls = 0;
    const nowFn = () => (calls++ === 0 ? 0 : 1000);

    const result = await drain(
      runVerifyFixLoop({
        ...noopArgsBase,
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 2,
        maxTotalMs: 1,
        nowFn,
      }),
    );

    expect(result.stopReason).toBe("deadline");
    expect(result.rounds).toEqual([]);
    expect(verifyPassCalls).toBe(0);
    expect(fixerCalls).toBe(0);
  });
});
