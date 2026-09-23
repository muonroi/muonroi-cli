/**
 * Regression: the engineering floor must not score a verified sprint 0 because
 * NOBODY MEASURED COVERAGE.
 *
 * ## The recorded case this replays
 *
 * Run `muauw6u93e1c` (tcis-libraries, a C# repo, 2026-09-21). Every value below
 * is copied from that run's own artifacts, never invented:
 *
 * - `.muonroi-cli/environment.json` → the recipe (REAL_DOTNET_RECIPE). It has
 *   test commands, and NO `coverage` key at all.
 * - `sprints/1-verify.md` → ends with `VERIFY_PASS`, states "build and full test
 *   suite now pass cleanly" and "**Blockers** None".
 * - `sprints/1-goal-gate.json` → `{"fired": false, "source": "aligned",
 *   "diffChars": 12710}` over 5+ real files, so real, goal-aligned code existed.
 * - `sprints/1-outcome.json` → `{"pass": false, "score": 0, "verify": "PASS",
 *   "failedCondition": "engineering_floor", "reason": "zero_coverage",
 *   "criteriaMet": 0, "criteriaUnmet": 8}`.
 * - `criteria.json` / `undebated-criteria.json` → the criterion ids below. Only
 *   SIX survive in the run's artifacts although the outcome recorded 8 unmet;
 *   the two others are not in any artifact, so they are not reconstructed here.
 *
 * The mechanism was `done-gate.ts`'s `const hasCoverage = (ctx.recipe?.coverage
 * ?? 0) > 0` — the `?? 0` turns "not measured" into "measured zero". It is
 * condition 1 of 5 and short-circuits, so nothing downstream ever ran.
 * `circuit-breakers.ts` read the SAME field with `=== 0`, i.e. the opposite
 * meaning for absent.
 */

import { describe, expect, it, vi } from "vitest";
import type { ToolResult, VerifyRecipe } from "../../types/index.js";
import { CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import type { Criterion, DoneGateContext, RoleSlot } from "../types.js";

/**
 * Verbatim from
 * `D:\sources\CompanyLibs\tcis-libraries\.muonroi-cli\environment.json`.
 * Note what is NOT here: a `coverage` key. That absence is the whole test.
 */
const REAL_DOTNET_RECIPE: VerifyRecipe = {
  ecosystem: "dotnet",
  appKind: "dotnet",
  appLabel: ".NET (Muonroi BB)",
  shellInitCommands: ["export DEBIAN_FRONTEND=noninteractive"],
  bootstrapCommands: [],
  installCommands: ['dotnet restore "src\\TCISLibraries.sln"'],
  buildCommands: ['dotnet build "src\\TCISLibraries.sln" --no-restore'],
  testCommands: ['dotnet test "src\\TCISLibraries.sln" --no-build --nologo'],
  smokeKind: "none",
  evidence: [
    "Detected .NET solution: src\\TCISLibraries.sln",
    "Detected Directory.Build.props (Muonroi BB ecosystem marker)",
  ],
  notes: ["Muonroi BB project — run `pwsh scripts/check-modular-boundaries.ps1` after build if the script is present."],
};

/** Tail of `sprints/1-verify.md`, verbatim. */
const REAL_VERIFY_OUTPUT = [
  "**Blockers**",
  "",
  "None. All 4 analyzer compiler errors were surgically fixed; build and full test suite now pass cleanly.",
  "",
  "---",
  "",
  "VERIFY_PASS",
].join("\n");

/** Criterion ids verbatim from `criteria.json` (all recorded `status: "unmet"`). */
const REAL_CRITERION_IDS = [
  "Gói NuGet TCIS.CodeStandards được build thành công và có mặt t… #19hbhk",
  "Visual Studio hiển thị warning trực tiếp khi vi phạm rule mà k… #1q341s",
  "Mỗi rule có thể bị tắt cục bộ qua #pragma warning disable TCIS… #191eu7",
  "Semantic grouping được mở rộng thành một rule đầy đủ (VD: TCIS… #hex6dk",
  "TCIS0003 có unit test đầy đủ (ít nhất 5 trường hợp) kiểm tra s… #wtaec7",
  "Ngưỡng độ dài dòng mặc định là 150 ký tự, đồng nhất giữa mã an… #18lr3m",
];

/**
 * A REAL C# citation: the path is one of the `diffFiles` entries in
 * `sprints/1-goal-gate.json`, and line 53 is the one `1-verify.md` names verbatim
 * ("Line 53: `argList` is used before declaration").
 *
 * This is deliberately a BARE `.cs:line` with no commit sha beside it. Until
 * `evidenceLooksValid` learned the .NET extensions, this exact string failed
 * done-gate condition #2 (`evidence_regex`) — the next link in the same chain,
 * one step past the engineering floor. See `evidence-extensions.test.ts`.
 */
const REAL_CS_CITATION = "src/src/TCIS.CodeStandards/Analyzers/TCIS0002_LineBreakStyleAnalyzer.cs:53";

function realCriteria(status: Criterion["status"]): Criterion[] {
  return REAL_CRITERION_IDS.map((id) =>
    status === "unmet" ? { id, status } : { id, status, evidence: REAL_CS_CITATION },
  );
}

function ctxFor(overrides: Partial<DoneGateContext> = {}): DoneGateContext {
  const roleAssignments = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
  roleAssignments.set("PO", { modelId: "po-model", provider: "provider-a", tier: "pro" });
  roleAssignments.set("Customer", { modelId: "customer-model", provider: "provider-b", tier: "pro" });
  return {
    recipe: REAL_DOTNET_RECIPE,
    // `sprints/1-outcome.json` recorded `"verify": "PASS"` for this sprint.
    verifyVerdict: "PASS",
    lastVerify: { success: true, output: REAL_VERIFY_OUTPUT } as ToolResult,
    criteria: realCriteria("unmet"),
    history: [],
    roleAssignments,
    llm: { generate: vi.fn().mockResolvedValue("SHIP") } as unknown as DoneGateContext["llm"],
    respondToPreflight: vi.fn().mockResolvedValue(true) as unknown as DoneGateContext["respondToPreflight"],
    doneThreshold: 0.9,
    ...overrides,
  };
}

describe("engineering floor — unmeasured coverage is not zero coverage (run muauw6u93e1c)", () => {
  it("no longer fails the floor with reason=zero_coverage on the REAL recorded sprint", async () => {
    const verdict = await evaluateDoneGate(ctxFor());

    // This is what `1-outcome.json` recorded and what must never happen again.
    expect(verdict.reason).not.toBe("zero_coverage");
    expect(verdict.failedCondition).not.toBe("engineering_floor");
  });

  it("proceeds past the floor and is judged on its criteria instead", async () => {
    const verdict = await evaluateDoneGate(ctxFor());

    // Six real criteria, every one `unmet` → score 0, so it fails condition #3
    // (weighted_score) — the sprint's ACTUAL shortcoming, not a phantom one.
    expect(verdict.failedCondition).toBe("weighted_score");
    expect(verdict.score).toBe(0);
    expect(verdict.pass).toBe(false);
  });

  it("lets the same recipe ship once its criteria are actually met", async () => {
    // Same absent-coverage recipe, same PASS verdict — only the criteria change.
    // Before the fix this returned engineering_floor/zero_coverage no matter
    // what the criteria said, which is how a run could never bank progress.
    const verdict = await evaluateDoneGate(ctxFor({ criteria: realCriteria("met") }));

    expect(verdict.failedCondition).toBeUndefined();
    expect(verdict.score).toBe(1);
    expect(verdict.pass).toBe(true);
  });

  it("still blocks when there is genuinely nothing to verify against", async () => {
    const verdict = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, testCommands: [] },
        criteria: realCriteria("met"),
      }),
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("no_test_commands");
  });

  it("still blocks on a MEASURED zero — a figure the floor parsed from real test output", async () => {
    const verdict = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "measured" },
        criteria: realCriteria("met"),
      }),
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("zero_coverage");
  });

  it("does NOT block on a MODEL-ASSERTED zero — that is a filled-in box, not a finding", async () => {
    // The recorded recipe had no `coverage` key AT ALL, which is what an honest
    // model does with a field it cannot fill. So a 0 appearing there is likelier a
    // formatting artifact than a measurement, and a silent per-sprint score of 0
    // that repeats forever is the very failure being removed — no second door.
    const verdict = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "model-asserted" },
        criteria: realCriteria("met"),
      }),
    );

    expect(verdict.reason).not.toBe("zero_coverage");
    expect(verdict.failedCondition).toBeUndefined();
    expect(verdict.pass).toBe(true);
  });

  it("does NOT block on an UNSTAMPED zero — unknown provenance cannot prove measurement", async () => {
    const verdict = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, coverage: 0 },
        criteria: realCriteria("met"),
      }),
    );

    expect(verdict.reason).not.toBe("zero_coverage");
    expect(verdict.pass).toBe(true);
  });

  it("an asserted zero never overrides the still-mandatory terms of the floor", async () => {
    // The risk accepted by not blocking on an asserted zero is bounded: tests must
    // still exist and verify must still be PASS.
    const noTests = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, testCommands: [], coverage: 0, coverageSource: "model-asserted" },
        criteria: realCriteria("met"),
      }),
    );
    expect(noTests.reason).toBe("no_test_commands");

    const verifyFailed = await evaluateDoneGate(
      ctxFor({
        recipe: { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "model-asserted" },
        verifyVerdict: "FAIL",
        criteria: realCriteria("met"),
      }),
    );
    expect(verifyFailed.reason).toBe("verify_FAIL");
  });

  it("still blocks when there is no recipe at all", async () => {
    const verdict = await evaluateDoneGate(ctxFor({ recipe: null, criteria: realCriteria("met") }));

    expect(verdict.pass).toBe(false);
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("no_recipe");
  });
});

describe("CB-3 and the done-gate: shared CLASSIFICATION, divergent POLICY on a zero", () => {
  /**
   * One table, both callers, every provenance. `cb3` and `doneGate` differ on
   * exactly one row — an UNVERIFIED zero — and that difference is intentional:
   *
   *  - CB-3's consequence is a loud sprint-1 halt with a recovery card the user
   *    answers, so an asserted zero costs one visible prompt. It also keeps CB-3's
   *    halt set byte-identical to the pre-`classifyCoverage` `=== 0` rule.
   *  - the done-gate's consequence is a silent per-sprint score of 0 that repeats
   *    forever, so only a figure the verify floor actually measured may cause it.
   *
   * If a future change makes these two columns identical, that is a regression in
   * one direction or the other — not a tidy-up.
   */
  const cases: Array<{ label: string; recipe: VerifyRecipe; cb3: boolean; doneGate: boolean }> = [
    { label: "coverage absent (the recorded case)", recipe: REAL_DOTNET_RECIPE, cb3: false, doneGate: false },
    { label: "coverage null", recipe: { ...REAL_DOTNET_RECIPE, coverage: null }, cb3: false, doneGate: false },
    {
      label: "coverage undefined",
      recipe: { ...REAL_DOTNET_RECIPE, coverage: undefined },
      cb3: false,
      doneGate: false,
    },
    {
      label: "zero, MEASURED by the floor",
      recipe: { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "measured" },
      cb3: true,
      doneGate: true,
    },
    {
      label: "zero, MODEL-ASSERTED — the divergent row",
      recipe: { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "model-asserted" },
      cb3: true,
      doneGate: false,
    },
    {
      label: "zero, provenance UNSTAMPED — also divergent",
      recipe: { ...REAL_DOTNET_RECIPE, coverage: 0 },
      cb3: true,
      doneGate: false,
    },
    {
      label: "0.42, measured",
      recipe: { ...REAL_DOTNET_RECIPE, coverage: 0.42, coverageSource: "measured" },
      cb3: false,
      doneGate: false,
    },
  ];

  for (const { label, recipe, cb3, doneGate } of cases) {
    it(`${label} → CB-3 halt=${cb3}, done-gate zero_coverage=${doneGate}`, async () => {
      const breaker = CB3_verifyBlank(1, recipe);
      expect(breaker.halt).toBe(cb3);
      if (cb3) expect(breaker.reason).toBe("zero_coverage");

      const verdict = await evaluateDoneGate(ctxFor({ recipe, criteria: realCriteria("met") }));
      expect(verdict.reason === "zero_coverage").toBe(doneGate);
    });
  }

  it("CB-3's halt set is byte-identical to the pre-classifyCoverage `coverage === 0` rule", () => {
    // Includes the no-test-commands shape, which the old rule halted on because it
    // never looked at `testCommands` — hence `classifyCoverage`'s field ordering.
    const legacyRule = (r: VerifyRecipe): boolean => r.coverage === 0;
    const shapes: VerifyRecipe[] = [
      REAL_DOTNET_RECIPE,
      { ...REAL_DOTNET_RECIPE, coverage: null },
      { ...REAL_DOTNET_RECIPE, coverage: undefined },
      { ...REAL_DOTNET_RECIPE, coverage: 0 },
      { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "model-asserted" },
      { ...REAL_DOTNET_RECIPE, coverage: 0, coverageSource: "measured" },
      { ...REAL_DOTNET_RECIPE, coverage: 0.001 },
      { ...REAL_DOTNET_RECIPE, testCommands: [], coverage: 0 },
      { ...REAL_DOTNET_RECIPE, testCommands: [], coverage: 0.5 },
    ];
    for (const shape of shapes) {
      expect(CB3_verifyBlank(1, shape).halt).toBe(legacyRule(shape));
    }
  });

  it("CB-3 still halts sprint 1 on a null recipe", () => {
    expect(CB3_verifyBlank(1, null)).toEqual({ halt: true, reason: "no_recipe" });
  });

  it("CB-3 never halts after sprint 1", () => {
    expect(CB3_verifyBlank(2, null).halt).toBe(false);
    expect(CB3_verifyBlank(2, { ...REAL_DOTNET_RECIPE, coverage: 0 }).halt).toBe(false);
  });
});
