/**
 * Coverage is now MEASURED, and the three coverage states are named apart.
 *
 * Two halves:
 *
 * 1. `coverage-signal.ts` — the single definition of what `VerifyRecipe.coverage`
 *    means, which `done-gate.ts` and `circuit-breakers.ts` both read so they
 *    cannot drift into the two contradictory readings they had at 97ff484e
 *    (`?? 0` vs `=== 0`).
 * 2. `verify-floor.ts` — the wiring that makes a real number exist at all.
 *    `extractCoverageFromOutput` had been unit-tested and production-dead since it
 *    was written: at 97ff484e its only non-test references were the import and
 *    re-export in `src/verify/recipes.ts` (lines 5 and 7). The floor is the one
 *    place the project's own test output is available, so that is where it runs.
 *
 * The floor tests execute REAL processes in REAL temp dirs, per the convention in
 * `verify-floor.test.ts` — a mocked spawn would assert nothing about parsing
 * actual command output.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerifyRecipe } from "../../types/index.js";
import { classifyCoverage, isClaimedZeroCoverage, isVerifiedZeroCoverage } from "../coverage-signal.js";
import { type FloorCheck, foldMeasuredCoverage, resolveFloorEcosystem, runVerifyFloor } from "../verify-floor.js";

function recipe(over: Partial<VerifyRecipe> = {}): VerifyRecipe {
  return {
    ecosystem: "dotnet",
    appKind: "dotnet",
    appLabel: ".NET project",
    shellInitCommands: [],
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: ["dotnet build"],
    testCommands: ["dotnet test"],
    smokeKind: "none",
    evidence: [],
    notes: [],
    ...over,
  };
}

describe("classifyCoverage — the three states", () => {
  it("tests exist and no figure was produced → unmeasured (NOT zero)", () => {
    expect(classifyCoverage(recipe())).toEqual({ state: "unmeasured" });
    expect(classifyCoverage(recipe({ coverage: null }))).toEqual({ state: "unmeasured" });
    expect(classifyCoverage(recipe({ coverage: undefined }))).toEqual({ state: "unmeasured" });
  });

  it("a real figure → measured, carrying the value and its provenance", () => {
    expect(classifyCoverage(recipe({ coverage: 0.675, coverageSource: "measured" }))).toEqual({
      state: "measured",
      value: 0.675,
      source: "measured",
    });
    expect(classifyCoverage(recipe({ coverage: 0, coverageSource: "model-asserted" }))).toEqual({
      state: "measured",
      value: 0,
      source: "model-asserted",
    });
  });

  it("an unstamped figure has provenance 'unknown' — it cannot prove it was measured", () => {
    // Records persisted before `coverageSource` existed land here.
    expect(classifyCoverage(recipe({ coverage: 0 }))).toEqual({ state: "measured", value: 0, source: "unknown" });
    expect(classifyCoverage(recipe({ coverage: 0.9, coverageSource: null }))).toEqual({
      state: "measured",
      value: 0.9,
      source: "unknown",
    });
  });

  it("no recipe, or no command and no figure → tests-absent", () => {
    expect(classifyCoverage(null)).toEqual({ state: "tests-absent" });
    expect(classifyCoverage(undefined)).toEqual({ state: "tests-absent" });
    expect(classifyCoverage(recipe({ testCommands: [] }))).toEqual({ state: "tests-absent" });
  });

  it("classifies a present figure BEFORE the missing-command check", () => {
    // Load-bearing ordering: CB-3's old rule was `recipe.coverage === 0`, with no
    // reference to test commands at all, so this input halted it and must still.
    expect(classifyCoverage(recipe({ testCommands: [], coverage: 0 }))).toMatchObject({
      state: "measured",
      value: 0,
    });
    expect(classifyCoverage(recipe({ testCommands: [], coverage: 0.5 }))).toMatchObject({
      state: "measured",
      value: 0.5,
    });
  });

  it("a non-finite number is not a measurement", () => {
    expect(classifyCoverage(recipe({ coverage: Number.NaN }))).toEqual({ state: "unmeasured" });
    expect(classifyCoverage(recipe({ coverage: Number.POSITIVE_INFINITY }))).toEqual({ state: "unmeasured" });
  });
});

describe("isVerifiedZeroCoverage — only a MEASURED zero (the done-gate's policy)", () => {
  it("is true only for a zero stamped as measured", () => {
    expect(isVerifiedZeroCoverage({ state: "measured", value: 0, source: "measured" })).toBe(true);
    expect(isVerifiedZeroCoverage({ state: "measured", value: -1, source: "measured" })).toBe(true);
    expect(isVerifiedZeroCoverage({ state: "measured", value: 0.01, source: "measured" })).toBe(false);
  });

  it("is FALSE for a model-asserted zero — a model filling in a box is not a measurement", () => {
    expect(isVerifiedZeroCoverage({ state: "measured", value: 0, source: "model-asserted" })).toBe(false);
  });

  it("is FALSE for an unstamped zero — unknown provenance cannot prove measurement", () => {
    expect(isVerifiedZeroCoverage({ state: "measured", value: 0, source: "unknown" })).toBe(false);
  });

  it("is false for unmeasured — the coercion this module deletes", () => {
    expect(isVerifiedZeroCoverage({ state: "unmeasured" })).toBe(false);
  });

  it("is false for tests-absent, which callers report under their own reason", () => {
    expect(isVerifiedZeroCoverage({ state: "tests-absent" })).toBe(false);
  });
});

describe("isClaimedZeroCoverage — any zero (CB-3's policy)", () => {
  it("is true for a zero of ANY provenance", () => {
    expect(isClaimedZeroCoverage({ state: "measured", value: 0, source: "measured" })).toBe(true);
    expect(isClaimedZeroCoverage({ state: "measured", value: 0, source: "model-asserted" })).toBe(true);
    expect(isClaimedZeroCoverage({ state: "measured", value: 0, source: "unknown" })).toBe(true);
  });

  it("is false for a non-zero figure, unmeasured, and tests-absent", () => {
    expect(isClaimedZeroCoverage({ state: "measured", value: 0.001, source: "unknown" })).toBe(false);
    expect(isClaimedZeroCoverage({ state: "unmeasured" })).toBe(false);
    expect(isClaimedZeroCoverage({ state: "tests-absent" })).toBe(false);
  });

  it("differs from isVerifiedZeroCoverage on exactly one input class: an unverified zero", () => {
    // The whole divergence, in one assertion. Same classification, different
    // policy — CB-3 halts loudly and answerably; the done-gate would fail
    // silently and forever, so it declines.
    const asserted = classifyCoverage(recipe({ coverage: 0, coverageSource: "model-asserted" }));
    expect(isClaimedZeroCoverage(asserted)).toBe(true);
    expect(isVerifiedZeroCoverage(asserted)).toBe(false);

    const measured = classifyCoverage(recipe({ coverage: 0, coverageSource: "measured" }));
    expect(isClaimedZeroCoverage(measured)).toBe(true);
    expect(isVerifiedZeroCoverage(measured)).toBe(true);
  });
});

describe("foldMeasuredCoverage — several commands, one number", () => {
  const check = (coverage: number | null | undefined): FloorCheck => ({
    kind: "test",
    command: "x",
    exitCode: 0,
    ok: true,
    timedOut: false,
    outputTail: "",
    elapsedMs: 1,
    coverage,
  });

  it("returns null — never 0 — when nothing measured", () => {
    expect(foldMeasuredCoverage([])).toBeNull();
    expect(foldMeasuredCoverage([check(null), check(undefined)])).toBeNull();
  });

  it("takes the maximum of the figures that exist", () => {
    expect(foldMeasuredCoverage([check(0.4), check(null), check(0.9)])).toBe(0.9);
  });

  it("folds to 0 only when every measuring command measured zero", () => {
    expect(foldMeasuredCoverage([check(0), check(0)])).toBe(0);
    expect(foldMeasuredCoverage([check(0), check(0.3)])).toBe(0.3);
  });
});

describe("runVerifyFloor — coverage comes from the project's own test output", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "coverage-measure-"));
    // A .sln at the root is what `detectDotnetRecipe` keys on, so the ecosystem
    // is DISCOVERED from disk exactly as it is in production — never passed in.
    writeFileSync(join(cwd, "Fixture.sln"), "Microsoft Visual Studio Solution File, Format Version 12.00\n", "utf8");
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("discovers the dotnet ecosystem from the working tree", () => {
    expect(resolveFloorEcosystem(cwd)).toBe("dotnet");
  });

  it("parses coverlet's Total row out of a real command's real stdout", async () => {
    // One process, printing the summary coverlet prints, read back through the
    // whole floor — spawn, capture, parse, fold.
    const printCoverlet =
      "node -e \"console.log('| Total   | 67.5% | 52.3%  | 70.6%  |'); console.log('  2 tests passed')\"";
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [], test: [printCoverlet] },
      timeoutMs: 30_000,
    });

    expect(res.verdict).toBe("pass");
    expect(res.measuredCoverage).toBe(0.675);
    expect(res.checks[0].coverage).toBe(0.675);
  });

  it("reports measuredCoverage=null when the runner prints no coverage — the run muauw6u93e1c case", async () => {
    // Verbatim shape of a real `dotnet test` summary line from that run's
    // `.muonroi-cli/verify-artifacts/test.log`. No coverage anywhere in it.
    const printPlainSummary =
      "node -e \"console.log('Passed!  - Failed:     0, Passed:    87, Skipped:     0, Total:    87, Duration: 7 s - TCIS.EventBus.Tests.dll (net8.0)')\"";
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [], test: [printPlainSummary] },
      timeoutMs: 30_000,
    });

    expect(res.verdict).toBe("pass");
    // NOT 0. The floor passed; it simply has nothing to say about coverage, and
    // saying "0" would be the assertion that started all of this.
    expect(res.measuredCoverage).toBeNull();
  });

  it("measures a genuine ZERO as 0, so the floor can still block on it", async () => {
    const printZero = "node -e \"console.log('| Total   | 0% | 0% | 0% |'); console.log('  1 tests passed')\"";
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [], test: [printZero] },
      timeoutMs: 30_000,
    });

    expect(res.measuredCoverage).toBe(0);
    // And once sprint-runner stamps it, THIS zero is the kind that fails the
    // done-gate's floor — it came from the project's own test output.
    const stamped = classifyCoverage(recipe({ coverage: res.measuredCoverage, coverageSource: "measured" }));
    expect(isVerifiedZeroCoverage(stamped)).toBe(true);
    expect(isClaimedZeroCoverage(stamped)).toBe(true);
  });

  it("does not attempt a measurement when no test command runs", async () => {
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: ['node -e "process.exit(0)"'], test: [] },
      timeoutMs: 30_000,
    });

    expect(res.measuredCoverage).toBeNull();
    // Build checks are never parsed for coverage.
    expect(res.checks.every((c) => c.coverage === null)).toBe(true);
  });

  it("carries measuredCoverage=null on an unavailable floor", async () => {
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [], test: [] },
      timeoutMs: 30_000,
    });

    expect(res.verdict).toBe("unavailable");
    expect(res.measuredCoverage).toBeNull();
  });
});
