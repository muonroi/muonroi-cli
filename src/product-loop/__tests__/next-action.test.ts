/**
 * The resume digest's `Next action` line, and the halt card's recommendation,
 * both come from `deriveNextAction`. These tests replay the case that motivated
 * it — run `muc2joffe506` on qa-platform — plus one case per failure kind the
 * done-gate and the verify floor can produce today.
 *
 * Every string quoted from `muc2joffe506` is copied out of its own artifacts
 * (`.muonroi-flow/runs/muc2joffe506/sprints/2-outcome.json` and `state.md`), not
 * invented for the test.
 */
import { describe, expect, it } from "vitest";
import { parseResumeDigest, renderResumeDigest } from "../../flow/run-artifacts.js";
import { deriveNextAction } from "../next-action.js";
import type { FloorCheckLike, FloorDelta } from "../verify-baseline.js";

/** A `FloorDelta` with only the fields a case under test actually sets. */
function delta(over: Partial<FloorDelta>): FloorDelta {
  return {
    verdict: "fail",
    newlyFailing: [],
    preExisting: [],
    fixed: [],
    buildAlreadyBroken: false,
    rule: "absolute",
    runIdVerified: true,
    ...over,
  };
}

describe("deriveNextAction", () => {
  describe("the muc2joffe506 case", () => {
    // sprints/2-outcome.json, verbatim:
    //   "failedCondition": "engineering_floor", "reason": "no_test_commands",
    //   "pass": false, "score": 0, "verify": "ERROR"
    const verdict = { pass: false, score: 0, failedCondition: "engineering_floor", reason: "no_test_commands" };

    it("does not tell the user to retry sprint 2 and nothing else", () => {
      const advice = deriveNextAction({ sprintN: 2, verdict, verifyVerdict: "ERROR" });
      // state.md said exactly this, and it named no action at all.
      expect(advice.action).not.toBe("Retry sprint 2: engineering_floor: no_test_commands");
      expect(advice.action).not.toMatch(/^Retry sprint 2\b/);
    });

    it("names the manifest as where the fix belongs when a test tree is undeclared", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict,
        verifyVerdict: "ERROR",
        // Measured on D:\sources\CompanyLibs\qa-platform: backend/requirements.txt
        // exists and contains no pytest, while backend/conftest.py opens with
        // "Pytest configuration for backend tests."
        testRunnerEvidence: [
          { dir: "backend", marker: "conftest.py", manifest: "requirements.txt", runner: "pytest", declared: false },
        ],
      });
      expect(advice.locus).toBe("manifest");
      expect(advice.action).toContain("pytest");
      expect(advice.action).toContain("backend/requirements.txt");
      expect(advice.action).toContain("backend/conftest.py");
    });

    it("still names a locus with no on-disk evidence to point at", () => {
      const advice = deriveNextAction({ sprintN: 2, verdict, verifyVerdict: "ERROR" });
      expect(advice.locus).toBe("manifest");
      expect(advice.action).toMatch(/test command/i);
    });
  });

  describe("gate-could-not-run surfaces the measured detail", () => {
    // The evidence strings are the ones verify-result.ts's patterns were built
    // from and quotes verbatim in its own comments.
    const checks: FloorCheckLike[] = [
      {
        kind: "test",
        command: 'cd backend && ".venv/Scripts/python.exe" -m pytest',
        ok: false,
        exitCode: 1,
        timedOut: false,
        couldNotRun: { kind: "dependency_missing", evidence: "No module named pytest" },
      },
    ];

    it("quotes the missing module and the command that never ran", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "FAIL",
        floorDelta: delta({
          failureKind: "gate-could-not-run",
          failedCommand: 'cd backend && ".venv/Scripts/python.exe" -m pytest',
        }),
        floorChecks: checks,
      });
      expect(advice.locus).toBe("environment");
      expect(advice.action).toContain("No module named pytest");
      expect(advice.action).toContain('cd backend && ".venv/Scripts/python.exe" -m pytest');
      expect(advice.action).not.toMatch(/^Retry sprint/);
    });

    it("distinguishes a missing launcher from a missing script", () => {
      const launcher = deriveNextAction({
        sprintN: 1,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "FAIL",
        floorDelta: delta({ failureKind: "gate-could-not-run", failedCommand: "cd backend && .venv/bin/pytest" }),
        floorChecks: [
          {
            kind: "test",
            command: "cd backend && .venv/bin/pytest",
            ok: false,
            exitCode: 1,
            timedOut: false,
            couldNotRun: {
              kind: "launcher_missing",
              evidence: "'.venv' is not recognized as an internal or external command",
            },
          },
        ],
      });
      expect(launcher.action).toMatch(/launcher/i);
      expect(launcher.action).toContain("'.venv' is not recognized as an internal or external command");

      const script = deriveNextAction({
        sprintN: 1,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "FAIL",
        floorDelta: delta({ failureKind: "gate-could-not-run", failedCommand: "npm test" }),
        floorChecks: [
          {
            kind: "test",
            command: "npm test",
            ok: false,
            exitCode: 1,
            timedOut: false,
            couldNotRun: { kind: "script_missing", evidence: 'npm error Missing script: "test"' },
          },
        ],
      });
      expect(script.locus).toBe("manifest");
      expect(script.action).toContain('npm error Missing script: "test"');
    });
  });

  describe("a genuine regression still says to fix and re-run", () => {
    it("names the broken tests and the retry", () => {
      const advice = deriveNextAction({
        sprintN: 3,
        verdict: { pass: false, score: 0.4, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "FAIL",
        floorDelta: delta({
          failureKind: "test-regression",
          rule: "delta",
          newlyFailing: ["tests/test_auth.py::test_login", "tests/test_auth.py::test_logout"],
        }),
      });
      expect(advice.locus).toBe("code");
      expect(advice.action).toContain("tests/test_auth.py::test_login");
      expect(advice.action).toMatch(/re-run sprint 3/i);
      expect(advice.sprintCanCarryIt).toBe(true);
    });

    it("only a locus a sprint owns is one a sprint can carry out", () => {
      const carried = (failedCondition: string, reason: string) =>
        deriveNextAction({ sprintN: 1, verdict: { pass: false, score: 0, failedCondition, reason } }).sprintCanCarryIt;
      // A sprint writes code and closes criteria. It does not edit the user's
      // manifest, install into the user's environment, or answer for the user.
      expect(carried("engineering_floor", "no_test_commands")).toBe(false);
      expect(carried("engineering_floor", "no_recipe")).toBe(false);
      expect(carried("user_approval", "user_rejected")).toBe(false);
      expect(carried("engineering_floor", "zero_coverage")).toBe(true);
      expect(carried("weighted_score", "score_below_threshold: 0.40 < 0.9")).toBe(true);
    });
  });

  describe("one message per failure the gate can report", () => {
    it("no_recipe points at the project, not at a retry", () => {
      const advice = deriveNextAction({
        sprintN: 1,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "no_recipe" },
        verifyVerdict: "UNKNOWN",
      });
      expect(advice.locus).toBe("recipe");
      expect(advice.action).not.toMatch(/^Retry sprint/);
      expect(advice.action).toMatch(/recipe/i);
    });

    it("zero_coverage asks for tests over the changed code", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "zero_coverage" },
        verifyVerdict: "PASS",
      });
      expect(advice.locus).toBe("code");
      expect(advice.action).toMatch(/coverage/i);
      expect(advice.action).toMatch(/re-run sprint 2/i);
      // The done-gate only reports this reason for a zero the floor MEASURED.
      expect(advice.action).toContain("MEASURED");
    });

    it("does not call CB-3's claimed zero a measurement", () => {
      // CB-3 halts on `isClaimedZeroCoverage` — a number the verify agent wrote
      // into its own recipe JSON, which nothing measured.
      const advice = deriveNextAction({
        sprintN: 1,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "zero_coverage" },
        coverageZeroProvenance: "claimed",
      });
      expect(advice.action).not.toContain("MEASURED");
      expect(advice.action).toMatch(/REPORTED/);
      expect(advice.action).toMatch(/recipe/i);
    });

    it("a verify stage that never reported says so instead of blaming the code", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "ERROR",
      });
      expect(advice.action).toMatch(/verify stage/i);
      expect(advice.action).toContain("sprints/2-verify.md");
      expect(advice.action).not.toMatch(/^Retry sprint/);
    });

    it("evidence_regex names the criteria missing evidence", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: {
          pass: false,
          score: 0.5,
          failedCondition: "evidence_regex",
          reason: "missing_evidence: C1, C3",
        },
        verifyVerdict: "PASS",
      });
      expect(advice.locus).toBe("criteria");
      expect(advice.action).toContain("C1, C3");
      expect(advice.action).toMatch(/evidence/i);
    });

    it("weighted_score names the gap and the threshold", () => {
      const advice = deriveNextAction({
        sprintN: 4,
        verdict: {
          pass: false,
          score: 0.4,
          failedCondition: "weighted_score",
          reason: "score_below_threshold: 0.40 < 0.9",
        },
        verifyVerdict: "PASS",
      });
      expect(advice.locus).toBe("criteria");
      expect(advice.action).toContain("0.40 < 0.9");
      expect(advice.action).toMatch(/re-run sprint 4/i);
    });

    it("assumption_ledger and user_approval need a human, not a sprint", () => {
      const ledger = deriveNextAction({
        sprintN: 2,
        verdict: {
          pass: false,
          score: 0.95,
          failedCondition: "assumption_ledger",
          reason: "unverified_critical_assumptions: A2 (the S3 bucket already exists...)",
        },
        verifyVerdict: "PASS",
      });
      expect(ledger.locus).toBe("human");
      expect(ledger.action).toContain("A2");

      const approval = deriveNextAction({
        sprintN: 2,
        verdict: { pass: false, score: 0.95, failedCondition: "user_approval", reason: "user_rejected" },
        verifyVerdict: "PASS",
      });
      expect(approval.locus).toBe("human");
      expect(approval.action).not.toMatch(/^Retry sprint/);
    });

    it("a pass keeps the advance-or-ship line", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: { pass: true, score: 1 },
        verifyVerdict: "PASS",
      });
      expect(advice.action).toBe("Definition-of-Done met — advance to the next phase or ship");
      expect(advice.locus).toBe("none");
    });

    it("an unrecognized condition still names the condition and its cause", () => {
      const advice = deriveNextAction({
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "customer_debate", reason: "customer_dissent" },
        verifyVerdict: "PASS",
      });
      expect(advice.action).toContain("customer_dissent");
      expect(advice.locus).not.toBe("none");
    });
  });

  describe("every message survives the digest round-trip", () => {
    const cases: Array<Parameters<typeof deriveNextAction>[0]> = [
      { sprintN: 2, verdict: { pass: true, score: 1 }, verifyVerdict: "PASS" },
      {
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "no_test_commands" },
        verifyVerdict: "ERROR",
        testRunnerEvidence: [
          { dir: "backend", marker: "conftest.py", manifest: "requirements.txt", runner: "pytest", declared: false },
        ],
      },
      {
        sprintN: 2,
        verdict: { pass: false, score: 0, failedCondition: "engineering_floor", reason: "verify_FAIL" },
        verifyVerdict: "FAIL",
        floorDelta: delta({ failureKind: "gate-could-not-run", failedCommand: "cd backend && python -m pytest" }),
        floorChecks: [
          {
            kind: "test",
            command: "cd backend && python -m pytest",
            ok: false,
            exitCode: 1,
            timedOut: false,
            couldNotRun: { kind: "dependency_missing", evidence: "No module named pytest" },
          },
        ],
      },
      {
        sprintN: 3,
        verdict: {
          pass: false,
          score: 0.4,
          failedCondition: "weighted_score",
          reason: "score_below_threshold: 0.40 < 0.9",
        },
        verifyVerdict: "PASS",
      },
    ];

    for (const [i, input] of cases.entries()) {
      it(`case ${i} renders and parses back byte-identically`, () => {
        const action = deriveNextAction(input).action;
        expect(action).not.toContain("\n");
        const parsed = parseResumeDigest(
          renderResumeDigest({ stage: `sprint-${input.sprintN}`, nextAction: action, sprintN: input.sprintN }),
        );
        expect(parsed?.nextAction).toBe(action);
      });
    }
  });
});
