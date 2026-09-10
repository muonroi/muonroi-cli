/**
 * F5 — the goal-contradiction gate.
 *
 * The fixture is the REAL defect: commit `6888526` in
 * `D:\sources\CompanyLibs\tcis-libraries`, checked in verbatim as
 * `fixtures/f5-tcis-6888526.diff`, judged against the REAL goal of run
 * `mttwpmu8ee5b` (`fixtures/f5-tcis-goal.ts`, read out of that run's
 * manifest.md + phases.md).
 *
 * Nothing in the gate — and nothing asserted here — names a framework, a
 * language or a file type. The gate is given the goal the user wrote and the
 * diff that was made, and the assertions are about WHAT THE JUDGE IS SHOWN and
 * WHICH WAY EACH FAILURE FALLS. That split matters: a stubbed judge can only
 * prove polarity, so the substantive claim ("it can catch this") is carried by
 * proving the decisive evidence actually reaches the prompt — which is exactly
 * what a head-sliced diff destroys, and what this repo's existing reviewer does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  budgetDiffByFile,
  type DiffRead,
  extractGoalVerdict,
  GOAL_GATE_DIFF_BUDGET,
  type GoalStatement,
  runGoalContradictionGate,
  splitDiffByFile,
} from "../goal-contradiction-gate.js";
import { F5_GOAL } from "./fixtures/f5-tcis-goal.js";

/** The real commit, normalised to LF so a CRLF checkout does not change offsets. */
const REAL_DIFF = readFileSync(join(__dirname, "fixtures", "f5-tcis-6888526.diff"), "utf8").replace(/\r\n/g, "\n");

/** The decisive line of the real defect, verbatim from the commit. */
const DECISIVE_REMOVAL = "-    <TargetFramework>netstandard2.0</TargetFramework>";

/** The fragment of the user's own text that the removal defeats. */
const GOAL_FRAGMENT = "báo warning trong visual studio";

/**
 * A REAL benign change against the SAME goal: the analyzer sources and the new
 * unit-test file from the very same commit, with the project/solution files
 * dropped. This is work that serves the goal — it is not a synthetic "no-op".
 */
const BENIGN_DIFF = splitDiffByFile(REAL_DIFF)
  .filter((s) => !s.includes(".csproj") && !s.includes(".sln"))
  .join("\n");

function fixedDiff(diff: string): (cwd: string) => DiffRead {
  return () => ({ ok: true, diff, origin: "working-tree" });
}

function judge(reply: string) {
  return { generate: vi.fn(async () => reply) };
}

const MODEL = "fixture-judge-model";

/** What a judge that read the prompt and found the defect actually returns. */
const CONTRADICTS_REPLY =
  "The goal is stated in the user's own words at the end of the request.\n\n" +
  "```goal-check\n" +
  JSON.stringify({
    verdict: "contradicts",
    contradictions: [
      {
        goal: GOAL_FRAGMENT,
        change: DECISIVE_REMOVAL,
        why: "the component is retargeted to a framework the IDE will not load it from, so no warning can ever appear",
      },
    ],
    rationale: "the change removes the only way the stated warning could reach the user",
  }) +
  "\n```\n";

const ALIGNED_REPLY =
  "Nothing here removes or disables anything the goal asks for.\n\n" +
  "```goal-check\n" +
  JSON.stringify({ verdict: "aligned", contradictions: [], rationale: "the change implements the stated rules" }) +
  "\n```\n";

describe("F5 goal-contradiction gate — the real 6888526 change", () => {
  it("puts the decisive removal AND the goal fragment in front of the judge", async () => {
    let prompt = "";
    const llm = judge(ALIGNED_REPLY);

    await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm,
      modelId: MODEL,
      diffReader: fixedDiff(REAL_DIFF),
      onPrompt: (p) => {
        prompt = p;
      },
    });

    // The user's own words, verbatim — not a restatement of them.
    expect(prompt).toContain(GOAL_FRAGMENT);
    // …every stated success criterion…
    for (const c of F5_GOAL.successCriteria) expect(prompt).toContain(c);
    // …and the line that defeats them.
    expect(prompt).toContain(DECISIVE_REMOVAL);
    expect(prompt).toContain("+    <TargetFramework>net9.0</TargetFramework>");
  });

  it("would have hidden that removal behind a head-slice — which is why the budget is per file", () => {
    // MEASURED, and the reason budgetDiffByFile exists: the decisive line sits
    // at byte ~23,600 of a 32,498-byte diff, behind a 460-line rewrite of one
    // analyzer. `src/product-loop/plan-adherence-review.ts` hands its reviewer
    // `diff.slice(0, 12000)`.
    expect(REAL_DIFF.slice(0, 12_000)).not.toContain("TargetFramework");
    expect(REAL_DIFF.indexOf(DECISIVE_REMOVAL)).toBeGreaterThan(20_000);

    const budgeted = budgetDiffByFile(REAL_DIFF, GOAL_GATE_DIFF_BUDGET);
    expect(budgeted.length).toBeLessThanOrEqual(REAL_DIFF.length);
    expect(budgeted).toContain(DECISIVE_REMOVAL);
    // Every changed file still contributes something.
    expect(splitDiffByFile(budgeted)).toHaveLength(splitDiffByFile(REAL_DIFF).length);
  });

  it("FLAGS, and names the goal it defeats and the line that defeats it", async () => {
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm: judge(CONTRADICTS_REPLY),
      modelId: MODEL,
      diffReader: fixedDiff(REAL_DIFF),
    });

    expect(out.fired).toBe(true);
    expect(out.source).toBe("contradicts");
    expect(out.contradictions).toHaveLength(1);
    expect(out.contradictions[0]?.evidenced).toBe(true);
    // The detail is the sprint's failure feedback — it must carry both halves,
    // never a bare count. "2 of 5 criteria unmet" is precisely what nobody acted on.
    expect(out.detail).toContain(GOAL_FRAGMENT);
    expect(out.detail).toContain(DECISIVE_REMOVAL);
  });

  it("does NOT flag the benign half of the very same commit", async () => {
    const llm = judge(ALIGNED_REPLY);
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm,
      modelId: MODEL,
      diffReader: fixedDiff(BENIGN_DIFF),
    });

    expect(BENIGN_DIFF).not.toContain("TargetFramework");
    expect(BENIGN_DIFF.length).toBeGreaterThan(1_000);
    expect(out.fired).toBe(false);
    expect(out.source).toBe("aligned");
    expect(out.contradictions).toEqual([]);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });
});

describe("F5 gate — judgement fails closed", () => {
  const cases: Array<[string, string]> = [
    ["prose with no verdict block at all", "Looks fine to me, I could not find anything wrong."],
    ["a truncated fence", '```goal-check\n{"verdict":"aligned","contradi'],
    ["a verdict word the contract does not define", '```goal-check\n{"verdict":"ok","contradictions":[]}\n```'],
    ["an empty reply", ""],
  ];

  for (const [label, reply] of cases) {
    it(`flags rather than approves on ${label}`, async () => {
      const out = await runGoalContradictionGate({
        goal: F5_GOAL,
        cwd: "/irrelevant",
        llm: judge(reply),
        modelId: MODEL,
        diffReader: fixedDiff(REAL_DIFF),
      });

      expect(out.fired).toBe(true);
      expect(out.source).toBe("unparseable");
      expect(out.detail).toContain("NOT been checked");
    });
  }

  it("keeps a 'contradicts' opinion that arrives with no evidence, marked unevidenced", async () => {
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm: judge(
        '```goal-check\n{"verdict":"contradicts","contradictions":[],"rationale":"this defeats the goal"}\n```',
      ),
      modelId: MODEL,
      diffReader: fixedDiff(REAL_DIFF),
    });

    // An opinion that the change contradicts the goal is never silently dropped…
    expect(out.fired).toBe(true);
    expect(out.contradictions).toHaveLength(1);
    // …but the reader is told it came without the evidence the contract demands.
    expect(out.contradictions[0]?.evidenced).toBe(false);
    expect(out.detail).toContain("[unevidenced]");
  });
});

describe("F5 gate — infrastructure fails open", () => {
  it("leaves the verdict alone when the diff cannot be read, and never calls the judge", async () => {
    const llm = judge(CONTRADICTS_REPLY);
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm,
      modelId: MODEL,
      diffReader: () => ({ ok: false, reason: "diff-unreadable", detail: "not a git repository" }),
    });

    expect(out.fired).toBe(false);
    expect(out.source).toBe("diff-unreadable");
    expect(out.detail).toContain("not a git repository");
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("leaves the verdict alone when nothing changed", async () => {
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm: judge(CONTRADICTS_REPLY),
      modelId: MODEL,
      diffReader: () => ({ ok: false, reason: "no-diff", detail: "no changes since HEAD" }),
    });
    expect(out.fired).toBe(false);
    expect(out.source).toBe("no-diff");
  });

  it("leaves the verdict alone when the judgement call throws", async () => {
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm: {
        generate: vi.fn(async () => {
          throw new Error("provider 503");
        }),
      },
      modelId: MODEL,
      diffReader: fixedDiff(REAL_DIFF),
    });

    expect(out.fired).toBe(false);
    expect(out.source).toBe("call-failed");
    expect(out.detail).toContain("provider 503");
  });

  it("leaves the verdict alone when there is no goal to judge against", async () => {
    const llm = judge(CONTRADICTS_REPLY);
    const out = await runGoalContradictionGate({
      goal: { idea: "   ", successCriteria: [] } as GoalStatement,
      cwd: "/irrelevant",
      llm,
      modelId: MODEL,
      diffReader: fixedDiff(REAL_DIFF),
    });

    expect(out.fired).toBe(false);
    expect(out.source).toBe("no-goal");
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("is off, and silent, under MUONROI_IDEAL_GOAL_GATE=0", async () => {
    const llm = judge(CONTRADICTS_REPLY);
    const out = await runGoalContradictionGate({
      goal: F5_GOAL,
      cwd: "/irrelevant",
      llm,
      modelId: MODEL,
      env: { MUONROI_IDEAL_GOAL_GATE: "0" } as NodeJS.ProcessEnv,
      diffReader: fixedDiff(REAL_DIFF),
    });

    expect(out.fired).toBe(false);
    expect(out.source).toBe("disabled");
    expect(llm.generate).not.toHaveBeenCalled();
  });
});

describe("F5 gate — verdict extraction", () => {
  it("takes the LAST labelled block, so a quoted example earlier cannot win", () => {
    const raw =
      'Here is the shape I must emit:\n```goal-check\n{"verdict":"contradicts","contradictions":[{"goal":"g","change":"c","why":"w"}]}\n```\n' +
      'Having read the diff:\n```goal-check\n{"verdict":"aligned","contradictions":[],"rationale":"fine"}\n```';
    expect(extractGoalVerdict(raw)?.verdict).toBe("aligned");
  });

  it("falls back to an unlabelled fence, then to a bare object", () => {
    expect(extractGoalVerdict('```json\n{"verdict":"aligned","contradictions":[]}\n```')?.verdict).toBe("aligned");
    expect(extractGoalVerdict('done. {"verdict":"contradicts","contradictions":["nope"]}')?.verdict).toBe(
      "contradicts",
    );
  });

  it("returns null — never a verdict — for anything it cannot read", () => {
    expect(extractGoalVerdict("")).toBeNull();
    expect(extractGoalVerdict("I think it is fine.")).toBeNull();
    expect(extractGoalVerdict('{"verdict":"maybe"}')).toBeNull();
  });
});
