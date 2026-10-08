/**
 * N4 — three instruments that read zero (or waved through) while the thing they
 * measure was non-zero. All three defects were measured on run `mttwpmu8ee5b`
 * against `D:\sources\CompanyLibs\tcis-libraries`:
 *
 *  (a) `state.md` "Phase Budget" recorded `startUsd:0 / endUsd:0 / spentUsd:0`
 *      for all four phases and `iterations.md` recorded `Cost: 0.000` for both
 *      sprints — for a run that spent $0.7798 (SUM(usage_events.cost_micros)
 *      over sessions 18cd54cdb9c9 + c712c4cb6908 + 9d9f363c14fa).
 *  (b) `iterations.md` recorded `TotalCriteria: 0` for both sprints while
 *      `phases.md` carried 5 `successCriteria` across P1–P4, so the loop could
 *      not notice it had shipped against unmet criteria.
 *  (c) `phases.md` gives every phase `exitCondition {min: 0.9}`; P1 finished at
 *      0.00 with verify FAIL on both sprints and was still marked `done`, so
 *      P2 (`dependsOn: ["P1"]`) started.
 *
 * `/ideal` has since lost its spend cap (user decision: no limits). The meter in
 * (a) stays — it is now the "Phase Spend" measurement — but CB-0 (halt on a blind
 * gauge to protect the cap) and the `remainingUsd` headroom gates are gone, and
 * the call-site pins below assert that.
 *
 * This repo has been bitten three times by a helper-level test staying green
 * while the real call site passed nothing, so every section below either drives
 * the production entry point (`runPhases`) or pins the production source.
 */

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readArtifact } from "../../flow/artifact-io.js";
import { criterionIdFromText, seedCriteriaFromPlan } from "../criteria-seed.js";
import { writePhasePlan } from "../phase-plan.js";
import { phaseExitSatisfied, runPhases } from "../phase-runner.js";

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// (a) the spend meter — real spend, and LOUD when it cannot read
// ─────────────────────────────────────────────────────────────────────────────

describe("N4(a) — phase spend reads the authoritative ledger, and never fails to zero", () => {
  let flowDir: string;
  const runId = "n4a";

  beforeEach(async () => {
    vi.resetModules();
    flowDir = path.join(os.tmpdir(), `n4a-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
  });

  async function withGauge(
    readings: Array<{ known: true; usd: number; sessionIds: string[] } | { known: false; reason: string }>,
  ) {
    const readRunSpendUsd = vi.fn();
    for (const r of readings) readRunSpendUsd.mockReturnValueOnce(r);
    vi.doMock("../run-spend.js", () => ({ readRunSpendUsd }));
    const mod = await import("../phase-budget.js");
    return { ...mod, readRunSpendUsd };
  }

  it("records a MEASURED delta, with the session chain that produced it", async () => {
    const { recordPhaseStart, recordPhaseEnd, renderPhaseSpendSummary } = await withGauge([
      { known: true, usd: 0.1, sessionIds: ["root", "sub"] },
      { known: true, usd: 0.88, sessionIds: ["root", "sub"] },
    ]);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "root" });
    await recordPhaseEnd({ flowDir, runId, marker });

    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const record = JSON.parse(map!.sections.get("Phase Spend")!).records[0];
    expect(record.spendKnown).toBe(true);
    expect(record.spentUsd).toBeCloseTo(0.78, 6);
    // Sub-agent attribution is the point: the isolated impl sub-agents bill under
    // their own session_id rows and are where the money went.
    expect(record.sessionIds).toEqual(["root", "sub"]);
    expect(await renderPhaseSpendSummary(flowDir, runId)).toContain("$0.780");
  });

  it("an unreadable gauge records UNKNOWN and warns — it must not render $0.000", async () => {
    const { recordPhaseStart, recordPhaseEnd, renderPhaseSpendSummary } = await withGauge([
      { known: false, reason: "usage_events query failed: disk I/O error" },
      { known: false, reason: "usage_events query failed: disk I/O error" },
    ]);
    const marker = await recordPhaseStart({ flowDir, runId, phase: "research", sessionId: "root" });
    const warning = await recordPhaseEnd({ flowDir, runId, marker });

    expect(warning).toContain("UNKNOWN");
    expect(warning).toContain("disk I/O error");

    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const record = JSON.parse(map!.sections.get("Phase Spend")!).records[0];
    expect(record.spendKnown).toBe(false);
    expect(record.spentUsd).toBeNull();
    expect(record.startUsd).toBeNull();

    const summary = await renderPhaseSpendSummary(flowDir, runId);
    expect(summary).toContain("UNKNOWN");
    expect(summary).not.toContain("$0.000");
  });

  it("CALL SITES: spend is measured from the authoritative gauge, and nothing gates on it", () => {
    const budget = src("../phase-budget.ts");
    expect(budget).toContain('from "./run-spend.js"');
    expect(budget).not.toContain("getProductSpentUsd");

    // All four loop-driver phase markers must pass the session id; without it the
    // gauge is blind and the meter degrades to exactly the measured defect.
    const driver = src("../loop-driver.ts");
    const starts = driver.match(/recordPhaseStart\(\{[\s\S]*?\}\)/g) ?? [];
    expect(starts).toHaveLength(4);
    for (const call of starts) expect(call).toContain("sessionId: ctx.sessionId");

    // No spend gate is wired ahead of runPhases any more: `/ideal` has no cap.
    const index = src("../index.ts");
    expect(index).not.toMatch(/CB0_budgetGaugeReadable\(/);
    expect(index).not.toMatch(/remainingUsd\s*:/);

    // The per-sprint Cost: line must be a measured delta, not a hardcoded 0.
    const sprint = src("../sprint-runner.ts");
    expect(sprint).toContain("const sprintSpendStart = readRunSpendUsd(ctx.sessionId);");
    expect(sprint).toContain("costUsd: sprintCostUsd,");
    expect(sprint).not.toMatch(/costUsd: 0, \/\/ Per-sprint cost is observed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) criteria actually reach the store the gate counts
// ─────────────────────────────────────────────────────────────────────────────

describe("N4(b) — a phase's successCriteria become real Criterion rows", () => {
  let flowDir: string;
  const runId = "n4b";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `n4b-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("seeds P1's real criterion so TotalCriteria can be non-zero", async () => {
    const { readCriteria } = await import("../artifact-io.js");
    // Verbatim P1 successCriteria from run mttwpmu8ee5b's phases.md.
    const p1 = ["Visual Studio hiển thị warning khi dòng code vượt quá 150 ký tự"];
    expect(await readCriteria(flowDir, runId)).toHaveLength(0);
    const seeded = await seedCriteriaFromPlan(flowDir, runId, p1, 1);
    expect(seeded).toBe(1);
    const rows = await readCriteria(flowDir, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unmet");
    // Idempotent: a sprint-2 retry must not double-count or reset progress.
    expect(await seedCriteriaFromPlan(flowDir, runId, p1, 2)).toBe(0);
  });

  it("the phase-scope filter matches on the seeder's id derivation, not raw text", () => {
    // P2's second criterion from the same run — 116 chars, so criterionIdFromText
    // truncates + hashes it. Comparing raw text to the id would never match.
    const long =
      "Visual Studio hiển thị warning khi thiếu dòng trống phân tách các nhóm logic khác nhau hoặc có nhiều dòng trống liên tiếp";
    expect(long.length).toBeGreaterThan(70);
    expect(criterionIdFromText(long)).not.toBe(long);
    const wanted = new Set([long].map((s) => criterionIdFromText(s).trim()));
    expect(wanted.has(criterionIdFromText(long).trim())).toBe(true);
  });

  it("CALL SITE: runSprint seeds phaseScope.criteria before it seeds the plan's", () => {
    const sprint = src("../sprint-runner.ts");
    expect(sprint).toContain("const phaseCriteriaTexts = phaseScope?.criteria ?? [];");
    expect(sprint).toContain(
      "const seededPhase = await seedCriteriaFromPlan(ctx.flowDir, ctx.runId, phaseCriteriaTexts, sprintN);",
    );
    // And the scoped done-gate filter must use the same id derivation.
    expect(sprint).toContain("phaseScope.criteria.map((s) => criterionIdFromText(s).trim())");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) the exit condition blocks dependents — driven through runPhases itself
// ─────────────────────────────────────────────────────────────────────────────

describe("N4(c) — a phase below its exitCondition blocks phases that dependOn it", () => {
  let flowDir: string;
  const runId = "n4c";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `n4c-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("phaseExitSatisfied is fail-CLOSED when no criteria were tracked", () => {
    // The exact shape of run mttwpmu8ee5b: TotalCriteria 0, threshold 0.9.
    const none = phaseExitSatisfied(0, 0, 0.9);
    expect(none.satisfied).toBe(false);
    expect(none.reason).toContain("no success criteria");
    expect(phaseExitSatisfied(0, 1, 0.9).satisfied).toBe(false);
    expect(phaseExitSatisfied(1, 1, 0.9).satisfied).toBe(true);
    expect(phaseExitSatisfied(9, 10, 0.9).satisfied).toBe(true);
  });

  async function driveTwoPhases(sprintReturn: {
    scoreBefore: number;
    scoreAfter: number;
    criteriaMet: number;
    totalCriteria: number;
  }) {
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "P1",
          name: "n",
          goal: "g",
          successCriteria: ["A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.9 },
          dependsOn: [],
          maxSprints: 2,
        },
        {
          id: "P2",
          name: "n",
          goal: "g",
          successCriteria: ["B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.9 },
          dependsOn: ["P1"],
          maxSprints: 1,
        },
      ],
    });
    const sprintRunner = vi.fn(async function* () {
      yield { type: "info", content: "" };
      return sprintReturn;
    });
    const args = {
      flowDir,
      runId,
      manifest: { idea: "X", maxSprints: 6, doneThreshold: 0.9, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A", "B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({ wentWell: ["w"], toImprove: ["i"], nextSprintFocus: "f" }),
          costUsd: 0,
        }),
      },
      leaderModelId: "m1",
      awaitCustomerVerdict: async () => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner,
    };
    // biome-ignore lint/suspicious/noExplicitAny: runPhases takes the full loop arg shape
    const gen = runPhases(args as any);
    let final: { pass: boolean; reason?: string } | undefined;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        final = n.value;
        break;
      }
    }
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const state = JSON.parse(map!.sections.get("Phase Plan State")!);
    return { final: final!, state, sprintRunner };
  }

  it("P1 at 0/0 criteria (the measured run) fails, P2 never runs, the run does not pass", async () => {
    const { final, state, sprintRunner } = await driveTwoPhases({
      scoreBefore: 0,
      scoreAfter: 0,
      criteriaMet: 0,
      totalCriteria: 0,
    });
    expect(state.phasesStatus.P1).toBe("failed");
    expect(state.phasesStatus.P2).toBe("blocked");
    expect(final.pass).toBe(false);
    expect(final.reason).toContain("phases-deadlocked");
    // P1 ran until two consecutive sprints made no progress (there is no sprint
    // ceiling any more — sprint-progress.ts); P2 contributed none.
    expect(sprintRunner).toHaveBeenCalledTimes(2);
  });

  it("a phase that clears its threshold still advances its dependents", async () => {
    const { final, state } = await driveTwoPhases({
      scoreBefore: 0,
      scoreAfter: 1,
      criteriaMet: 1,
      totalCriteria: 1,
    });
    expect(state.phasesStatus.P1).toBe("done");
    expect(state.phasesStatus.P2).toBe("done");
    expect(final.pass).toBe(true);
  });
});
