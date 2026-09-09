import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFailingTestIds } from "../test-failure-parse.js";
import {
  computeFloorDelta,
  isToleratedTestFailure,
  VERIFY_BASELINE_VERSION,
  type VerifyBaseline,
} from "../verify-baseline.js";
import { captureVerifyFloorBaseline, runVerifyFloor } from "../verify-floor.js";

/**
 * The floor's own tests spawn REAL processes with REAL exit codes; so do these.
 * The whole claim under test is "an exit code no longer decides the verdict on
 * its own", and a mocked spawn would assert nothing about that.
 *
 * The fake runner prints xUnit-shaped lines for whichever tests `fail.json`
 * names, so a "regression" is created by editing one JSON file — the same
 * observable a real sprint produces.
 */

const RUNNER = `const fs = require("node:fs");
const path = require("node:path");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "fail.json"), "utf8"));
for (const n of names) console.log("[xUnit.net 00:00:01.00]     " + n + " [FAIL]");
console.log("Total tests: " + (names.length + 10));
process.exit(names.length ? 1 : 0);
`;

const PRE_EXISTING = [
  "TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.TenantSchemaWins_OverFallbackSchema",
  "TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.TenantSeesOnlyItsOwnRows",
];

let cwd: string;
const TEST_CMD = "node runner.cjs";
const OK_BUILD = 'node -e "process.exit(0)"';
const BAD_BUILD = "node -e \"console.error('CS0103: the name does not exist'); process.exit(1)\"";

function setFailing(names: string[]): void {
  writeFileSync(join(cwd, "fail.json"), JSON.stringify(names), "utf8");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "floor-delta-"));
  writeFileSync(join(cwd, "runner.cjs"), RUNNER, "utf8");
  setFailing(PRE_EXISTING);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const commands = (build: string[] = [OK_BUILD]) => ({ build, test: [TEST_CMD] });
const baselineAt = () => join(cwd, "verify-baseline.json");

async function capture(build: string[] = [OK_BUILD]) {
  return captureVerifyFloorBaseline({
    cwd,
    runId: "run-A",
    baselinePath: baselineAt(),
    commandsOverride: commands(build),
  });
}

async function floor(opts: { runId?: string; baselinePath?: string | null; build?: string[] } = {}) {
  return runVerifyFloor({
    cwd,
    forceEnable: true,
    commandsOverride: commands(opts.build ?? [OK_BUILD]),
    baselinePath: opts.baselinePath === undefined ? baselineAt() : opts.baselinePath,
    runId: opts.runId ?? "run-A",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The measured bug: a repo with pre-existing failures could never pass
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — gates on the delta, not on zero", () => {
  it("PASSES a repo whose only failures were already failing before the run", async () => {
    await capture();

    const res = await floor();

    expect(res.verdict).toBe("pass");
    expect(res.delta?.rule).toBe("delta");
    expect(res.delta?.newlyFailing).toEqual([]);
    expect(res.delta?.preExisting).toEqual([...PRE_EXISTING].sort());
    // The test command really did exit non-zero — the verdict is not an artefact
    // of the runner suddenly going green.
    expect(res.checks.find((c) => c.kind === "test")?.exitCode).toBe(1);
    expect(res.detail).toContain("ignored on purpose");
  });

  it("still FAILS when the run breaks a test that was passing at baseline", async () => {
    await capture();
    setFailing([...PRE_EXISTING, "TCIS.Analyzers.Tests.NewRuleTests.FlagsTheViolation"]);

    const res = await floor();

    expect(res.verdict).toBe("fail");
    expect(res.delta?.failureKind).toBe("test-regression");
    expect(res.delta?.newlyFailing).toEqual(["TCIS.Analyzers.Tests.NewRuleTests.FlagsTheViolation"]);
    expect(res.delta?.preExisting).toEqual([...PRE_EXISTING].sort());
    expect(res.detail).toContain("BROKE 1 TEST(S)");
    expect(res.detail).toContain("TCIS.Analyzers.Tests.NewRuleTests.FlagsTheViolation");
  });

  it("reports tests the run FIXED without letting them change the verdict", async () => {
    await capture();
    setFailing([PRE_EXISTING[0]]);

    const res = await floor();

    expect(res.verdict).toBe("pass");
    expect(res.delta?.fixed).toEqual([PRE_EXISTING[1]]);
    expect(res.detail).toContain("1 test(s) that were failing at baseline now pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint 1 — the missing-baseline fallback, and that it is stated
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — missing baseline falls back to ABSOLUTE, and says so", () => {
  it("FAILS with the absolute rule when no baseline is configured", async () => {
    const res = await floor({ baselinePath: null });

    expect(res.verdict).toBe("fail");
    expect(res.delta?.rule).toBe("absolute");
    expect(res.delta?.rejectReason).toBe("not-configured");
    expect(res.delta?.failureKind).toBe("test-absolute-no-baseline");
    expect(res.detail).toContain("Rule applied: ABSOLUTE (fail-closed)");
    expect(res.detail).toContain("no baseline was configured for this run");
    expect(res.detail).toContain("MUONROI_SPRINT_FLOOR_BASELINE");
  });

  it("FAILS when the configured baseline file is absent", async () => {
    const res = await floor({ baselinePath: join(cwd, "does-not-exist.json") });
    expect(res.verdict).toBe("fail");
    expect(res.delta?.rejectReason).toBe("missing");
  });

  it("FAILS when the baseline file is corrupt rather than trusting it", async () => {
    writeFileSync(baselineAt(), "{ not json", "utf8");
    const res = await floor();
    expect(res.verdict).toBe("fail");
    expect(res.delta?.rejectReason).toBe("unreadable");
  });

  it("honours MUONROI_SPRINT_FLOOR_BASELINE when no path is passed in", async () => {
    await capture();
    const prev = process.env.MUONROI_SPRINT_FLOOR_BASELINE;
    process.env.MUONROI_SPRINT_FLOOR_BASELINE = baselineAt();
    try {
      const res = await runVerifyFloor({ cwd, forceEnable: true, commandsOverride: commands(), runId: "run-A" });
      expect(res.verdict).toBe("pass");
      expect(res.delta?.rule).toBe("delta");
    } finally {
      if (prev === undefined) delete process.env.MUONROI_SPRINT_FLOOR_BASELINE;
      else process.env.MUONROI_SPRINT_FLOOR_BASELINE = prev;
    }
  });

  it("PASSES a green suite even with no baseline — absolute is a floor, not a veto", async () => {
    setFailing([]);
    const res = await floor({ baselinePath: null });
    expect(res.verdict).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint 3 — a baseline is scoped; a stale one may not authorise anything
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — baseline staleness", () => {
  it("records what it was captured against", async () => {
    const { baseline, path } = await capture();
    expect(baseline.runId).toBe("run-A");
    expect(baseline.version).toBe(VERIFY_BASELINE_VERSION);
    expect(baseline.commands.test).toEqual([TEST_CMD]);
    expect(baseline.failingTests).toEqual([...PRE_EXISTING].sort());
    expect(baseline.buildOk).toBe(true);
    expect(baseline.capturedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as VerifyBaseline;
    expect(onDisk.cwd).toBe(cwd);
  });

  it("rejects a baseline belonging to another run", async () => {
    await capture();
    const res = await floor({ runId: "run-B" });
    expect(res.verdict).toBe("fail");
    expect(res.delta?.rejectReason).toBe("different-run");
  });

  it("rejects a baseline captured with a different command set", async () => {
    await capture();
    const res = await floor({ build: [OK_BUILD, 'node -e "process.exit(0)"'] });
    expect(res.verdict).toBe("fail");
    expect(res.delta?.rejectReason).toBe("commands-changed");
  });

  it("rejects a baseline captured in a different working tree", async () => {
    const { baseline } = await capture();
    writeFileSync(baselineAt(), JSON.stringify({ ...baseline, cwd: join(tmpdir(), "somewhere-else") }), "utf8");
    const res = await floor();
    expect(res.verdict).toBe("fail");
    expect(res.delta?.rejectReason).toBe("different-working-tree");
  });

  it("says so when the caller named no run, so the run id could not be checked", async () => {
    await capture();
    // The MUONROI_SPRINT_FLOOR_BASELINE escape hatch: a path, but no run id to
    // check it against. The baseline still applies — but the message must not
    // read like a verified scope.
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: commands(),
      baselinePath: baselineAt(),
    });
    expect(res.verdict).toBe("pass");
    expect(res.delta?.runIdVerified).toBe(false);
    expect(res.detail).toContain("that run id was NOT checked against this one");
  });

  it("rejects a baseline written by an older version of the gate", async () => {
    const { baseline } = await capture();
    writeFileSync(baselineAt(), JSON.stringify({ ...baseline, version: VERIFY_BASELINE_VERSION - 1 }), "utf8");
    const res = await floor();
    expect(res.delta?.rejectReason).toBe("version-mismatch");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint 2 — a build failure is not a test failure
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — build and tests are distinct verdicts", () => {
  it("distinguishes a build the run broke from one that was already broken", async () => {
    // Baseline captured with the build ALREADY red.
    const { baseline } = await capture([BAD_BUILD]);
    expect(baseline.buildOk).toBe(false);

    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: commands([BAD_BUILD]),
      baselinePath: baselineAt(),
      runId: "run-A",
    });
    expect(res.verdict).toBe("fail");
    expect(res.delta?.failureKind).toBe("build-failed");
    expect(res.delta?.buildAlreadyBroken).toBe(true);
    expect(res.detail).toContain("ALREADY failing at baseline");
    expect(res.detail).not.toContain("BROKE THE BUILD");
  });

  it("says BROKE THE BUILD when the baseline built cleanly and this run does not", async () => {
    // Capture against a passing build, then evaluate a failing one under the
    // same recorded command list by rewriting only the baseline's command set.
    const { baseline } = await capture([BAD_BUILD]);
    writeFileSync(baselineAt(), JSON.stringify({ ...baseline, buildOk: true, failingTests: PRE_EXISTING }), "utf8");

    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: commands([BAD_BUILD]),
      baselinePath: baselineAt(),
      runId: "run-A",
    });
    expect(res.verdict).toBe("fail");
    expect(res.delta?.failureKind).toBe("build-failed");
    expect(res.delta?.buildAlreadyBroken).toBe(false);
    expect(res.detail).toContain("BROKE THE BUILD");
    // The raw tail is still carried for a build failure — the compiler message
    // is the only evidence there is.
    expect(res.detail).toContain("CS0103");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint 5 — the floor is not weaker overall
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — a baseline cannot launder an unreadable failure", () => {
  it("FAILS when a test command fails but names no test", async () => {
    await capture();
    // A runner whose failure output has no recognisable test identity.
    const opaque = "node -e \"console.log('something went wrong'); process.exit(1)\"";
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [OK_BUILD], test: [opaque] },
      baselinePath: baselineAt(),
      runId: "run-A",
    });
    // Command set changed, so the baseline is rejected outright — and even had
    // it applied, an unattributable failure is never tolerated (unit test below).
    expect(res.verdict).toBe("fail");
  });

  it("never tolerates an unattributable, timed-out or zero-test failure", () => {
    const baseline: VerifyBaseline = {
      version: VERIFY_BASELINE_VERSION,
      runId: "r",
      capturedAtUtc: new Date().toISOString(),
      cwd,
      gitCommit: null,
      gitBranch: null,
      gitDirty: null,
      commands: { build: [], test: [TEST_CMD] },
      buildOk: true,
      failingTests: PRE_EXISTING,
      results: [],
      unattributable: false,
    };
    const base = { kind: "test" as const, command: TEST_CMD, ok: false, exitCode: 1, timedOut: false };

    expect(isToleratedTestFailure({ ...base, failingTests: PRE_EXISTING }, baseline)).toBe(true);
    expect(isToleratedTestFailure({ ...base, failingTests: [] }, baseline)).toBe(false);
    expect(isToleratedTestFailure({ ...base, failingTests: PRE_EXISTING, timedOut: true }, baseline)).toBe(false);
    expect(isToleratedTestFailure({ ...base, failingTests: PRE_EXISTING, spawnError: "ENOENT" }, baseline)).toBe(false);
    expect(
      isToleratedTestFailure(
        { ...base, failingTests: PRE_EXISTING, noTests: { kind: "empty_selection", evidence: "no tests ran" } },
        baseline,
      ),
    ).toBe(false);
    expect(isToleratedTestFailure({ ...base, failingTests: PRE_EXISTING }, null)).toBe(false);
  });

  it("rejects a baseline that could not attribute its own failures", () => {
    const delta = computeFloorDelta(
      [{ kind: "test", command: TEST_CMD, ok: false, exitCode: 1, timedOut: false, failingTests: ["a"] }],
      { baseline: null, reason: "baseline-unattributable", path: "x" },
    );
    expect(delta.verdict).toBe("fail");
    expect(delta.rule).toBe("absolute");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate 4 — the recorded artifact from the run that motivated this change
// ─────────────────────────────────────────────────────────────────────────────

describe("verify floor — replay of tcis-libraries run mttwpmu8ee5b", () => {
  const recorded = readFileSync(join(import.meta.dirname, "fixtures", "tcis-mttwpmu8ee5b-sprint-1-verify.md"), "utf8");
  const recordedIds = parseFailingTestIds(recorded).ids;

  const buildCmd = 'dotnet build "src\\TCISLibraries.sln" --no-restore';
  const testCmd = 'dotnet test "src\\TCISLibraries.sln" --no-build --nologo';

  const checks = (failing: string[]) => [
    { kind: "build" as const, command: buildCmd, ok: true, exitCode: 0, timedOut: false },
    { kind: "test" as const, command: testCmd, ok: false, exitCode: 1, timedOut: false, failingTests: failing },
  ];

  const baseline: VerifyBaseline = {
    version: VERIFY_BASELINE_VERSION,
    runId: "mttwpmu8ee5b",
    capturedAtUtc: "2026-09-09T09:00:00.000Z",
    cwd: "D:\\sources\\CompanyLibs\\tcis-libraries",
    gitCommit: "0123456789abcdef",
    gitBranch: "main",
    gitDirty: false,
    commands: { build: [buildCmd], test: [testCmd] },
    buildOk: true,
    failingTests: recordedIds,
    results: [],
    unattributable: false,
  };

  it("the recorded output is exactly what the OLD absolute rule failed on", () => {
    // Build OK, tests EXIT 1 — the artifact's own two lines. Absolute compares
    // against zero, so this is a FAIL no matter what failed or why.
    const absolute = computeFloorDelta(checks(recordedIds), {
      baseline: null,
      reason: "not-configured",
      path: null,
    });
    expect(absolute.verdict).toBe("fail");
    expect(absolute.rule).toBe("absolute");
  });

  it("PASSES the same recorded output once its failures are known to be inherited", () => {
    const delta = computeFloorDelta(checks(recordedIds), { baseline, path: "baseline.json" });

    expect(delta.verdict).toBe("pass");
    expect(delta.newlyFailing).toEqual([]);
    expect(delta.preExisting).toHaveLength(recordedIds.length);
    expect(delta.preExisting).toContain(
      "TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.TenantSchemaWins_OverFallbackSchema",
    );
  });

  it("still FAILS that repo when the run breaks an unrelated, previously-passing test", () => {
    const withRegression = [...recordedIds, "TCIS.Analyzers.Tests.SentinelRuleTests.ReportsOnDirectNewOfHttpClient"];
    const delta = computeFloorDelta(checks(withRegression), { baseline, path: "baseline.json" });

    expect(delta.verdict).toBe("fail");
    expect(delta.failureKind).toBe("test-regression");
    expect(delta.newlyFailing).toEqual(["TCIS.Analyzers.Tests.SentinelRuleTests.ReportsOnDirectNewOfHttpClient"]);
    expect(delta.preExisting).toHaveLength(recordedIds.length);
  });
});
