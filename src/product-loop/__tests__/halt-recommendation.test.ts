/**
 * The halt card's pre-selected option, its "recommended" marker and its reason
 * line must always name the SAME option, and that option must never be a
 * destructive one.
 *
 * ## Why a property test and not examples
 *
 * The defect being prevented is divergence between independently computed
 * answers — the post-debate card (109aeef7) recommended "Save & Exit" beside a
 * reason computed for refine, and the halt card pre-selected index 0 ("Init new
 * project") with no reason computed at all. An example test passes happily while
 * two computations drift on the inputs it does not cover, so the invariants are
 * asserted over EVERY option list the code can produce: all 2^7 subsets of the
 * seven `RecoveryOption` ids, in two orderings, against every `FixLocus` plus
 * "no advice at all", against every halt `reason`, with and without a `detail`
 * that already quotes the advice.
 */

import { describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_RECOVERY_OPTION_IDS,
  deriveHaltRecommendation,
  type HaltRecommendationInput,
} from "../halt-recommendation.js";
import type { FixLocus, NextActionAdvice } from "../next-action.js";
import type { HaltChunk, RecoveryOption } from "../types.js";

const ALL_OPTION_IDS: readonly RecoveryOption["id"][] = [
  "init_new",
  "point_to_existing",
  "continue_as_council",
  "resume",
  "retry",
  "skip_verify",
  "abort",
];

const ALL_LOCI: readonly FixLocus[] = ["code", "criteria", "manifest", "environment", "recipe", "human", "none"];

const ALL_REASONS: readonly HaltChunk["reason"][] = ["no_recipe", "zero_coverage", "budget_exhausted", "sprint_failed"];

/** Loci a sprint can act on by itself — mirrors SPRINT_OWNED in next-action.ts. */
const SPRINT_OWNED: readonly FixLocus[] = ["code", "criteria"];

function option(id: RecoveryOption["id"]): RecoveryOption {
  return { id, label: `Label for ${id}`, description: `What ${id} does.` };
}

/** Every subset of the option ids (2^7 = 128), each as a real option list. */
function everyOptionList(): RecoveryOption[][] {
  const lists: RecoveryOption[][] = [];
  for (let mask = 0; mask < 1 << ALL_OPTION_IDS.length; mask++) {
    const ids = ALL_OPTION_IDS.filter((_, i) => (mask & (1 << i)) !== 0);
    lists.push(ids.map(option));
    if (ids.length > 1) lists.push([...ids].reverse().map(option));
  }
  return lists;
}

function advice(locus: FixLocus, action = `Do the ${locus} thing`): NextActionAdvice {
  return { action, locus, sprintCanCarryIt: SPRINT_OWNED.includes(locus) };
}

/** Every (option list x advice-or-none x detail-shape) input the card can face. */
function* everyInput(): Generator<HaltRecommendationInput> {
  for (const recovery_options of everyOptionList()) {
    for (const adv of [undefined, ...ALL_LOCI.map((l) => advice(l))]) {
      const details = adv ? [undefined, adv.action, "Something else entirely"] : [undefined, "Something else entirely"];
      for (const detail of details) {
        yield { recovery_options, ...(adv ? { advice: adv } : {}), ...(detail ? { detail } : {}) };
      }
    }
  }
}

describe("deriveHaltRecommendation — one slot, so index / option / reason cannot disagree", () => {
  it("never disagrees with itself, on any option list the code can produce", () => {
    const violations: string[] = [];
    let inputs = 0;
    for (const input of everyInput()) {
      inputs++;
      const rec = deriveHaltRecommendation(input);
      const options = input.recovery_options;
      const where = `[${options.map((o) => o.id).join(",")}] locus=${input.advice?.locus ?? "(none)"} detail=${input.detail ? "yes" : "no"}`;

      // The index and the id are the same slot.
      if (rec.index === -1) {
        if (rec.optionId !== null) violations.push(`${where}: index -1 but optionId ${rec.optionId}`);
        if (rec.kind !== "none") violations.push(`${where}: index -1 but kind ${rec.kind}`);
      } else {
        if (rec.index < 0 || rec.index >= options.length) violations.push(`${where}: index ${rec.index} out of range`);
        else if (options[rec.index].id !== rec.optionId) {
          violations.push(`${where}: index names ${options[rec.index].id} but optionId is ${rec.optionId}`);
        }
        if (rec.kind === "none") violations.push(`${where}: kind none but index ${rec.index}`);
        // The reason names the very option the cursor is on.
        if (!rec.reason.includes(options[rec.index].label)) {
          violations.push(`${where}: reason does not name ${options[rec.index].label}: ${rec.reason}`);
        }
      }
      if (rec.reason.trim() === "") violations.push(`${where}: empty reason`);
      // Deterministic: the card and the hook call it separately.
      if (JSON.stringify(deriveHaltRecommendation(input)) !== JSON.stringify(rec)) {
        violations.push(`${where}: not deterministic`);
      }
    }
    expect(violations).toEqual([]);
    expect(inputs).toBeGreaterThan(1_000);
  });

  it("never pre-selects a destructive option, on any option list the code can produce", () => {
    const violations: string[] = [];
    for (const input of everyInput()) {
      const rec = deriveHaltRecommendation(input);
      if (rec.index < 0) continue;
      const chosen = input.recovery_options[rec.index];
      if (DESTRUCTIVE_RECOVERY_OPTION_IDS.has(chosen.id)) {
        violations.push(`[${input.recovery_options.map((o) => o.id).join(",")}] pre-selected ${chosen.id}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("pre-selects nothing exactly when every offered option is destructive", () => {
    const violations: string[] = [];
    for (const input of everyInput()) {
      const rec = deriveHaltRecommendation(input);
      const hasSafe = input.recovery_options.some((o) => !DESTRUCTIVE_RECOVERY_OPTION_IDS.has(o.id));
      if (hasSafe && rec.index < 0) violations.push(`safe option existed but nothing was pre-selected`);
      if (!hasSafe && rec.index >= 0) violations.push(`only destructive options but index ${rec.index}`);
    }
    expect(violations).toEqual([]);
  });

  it("only calls it a recommendation when an offered option performs the fix", () => {
    // `manifest` / `environment` / `human` fixes happen outside this card: no
    // option may be dressed up as carrying them out.
    for (const locus of ["manifest", "environment", "human", "none"] as const) {
      const rec = deriveHaltRecommendation({
        recovery_options: ALL_OPTION_IDS.map(option),
        advice: advice(locus),
      });
      expect(rec.kind).toBe("safest-available");
      expect(rec.reason).toContain("Nothing offered carries out the actual fix");
    }
    // `recipe` IS carried out — by pointing the run at a tree that has one.
    const recipeRec = deriveHaltRecommendation({
      recovery_options: ALL_OPTION_IDS.map(option),
      advice: advice("recipe"),
    });
    expect(recipeRec.kind).toBe("carries-the-fix");
    expect(recipeRec.optionId).toBe("point_to_existing");
  });

  it("does not print the advice twice when the card already shows it as detail", () => {
    const adv = advice("recipe", "Point /ideal at the sub-project that holds the tests");
    const rec = deriveHaltRecommendation({
      recovery_options: [option("point_to_existing")],
      advice: adv,
      detail: adv.action,
    });
    expect(rec.reason).not.toContain(adv.action);
    expect(rec.reason).toContain("what the line above asks for");
  });

  it("is reason-agnostic — the halt reason alone never changes the answer", () => {
    const base = { recovery_options: ALL_OPTION_IDS.map(option), advice: advice("recipe") };
    const answers = new Set(ALL_REASONS.map((reason) => JSON.stringify(deriveHaltRecommendation({ ...base, reason }))));
    expect(answers.size).toBe(1);
  });
});

describe("deriveHaltRecommendation — the two lists the code actually produces", () => {
  /** The CB-3 list, verbatim from sprint-runner.ts:1962. */
  const CB3_OPTIONS: RecoveryOption[] = [
    {
      id: "init_new",
      label: "Init new project",
      description: "Bootstrap a new project from muonroi-building-block (BE) + a FE adapter.",
    },
    {
      id: "point_to_existing",
      label: "Point to existing project",
      description: "Provide a path; re-run verify-detect against that directory.",
    },
    {
      id: "continue_as_council",
      label: "Continue as council brainstorm",
      description: "Skip CB-3 and verify gates; produce a spec.md from a council debate.",
    },
  ];

  /** SPRINT_FAILED_RECOVERY_OPTIONS, verbatim from use-app-logic.tsx:327. */
  const SPRINT_FAILED_OPTIONS: RecoveryOption[] = [
    {
      id: "resume",
      label: "Resume",
      description: "Continue the run from where it broke (restarts the failed sprint).",
    },
    { id: "retry", label: "Retry sprint", description: "Re-run the sprint that just failed from a clean slate." },
    {
      id: "skip_verify",
      label: "Skip verify & resume",
      description: "Bypass the verify stage (use when the sandbox/verify is what hangs), then continue.",
    },
    { id: "abort", label: "Abort run", description: "Hard-kill this run. It can no longer be resumed." },
  ];

  it("CB-3 no_recipe pre-selects 'Point to existing project', not 'Init new project'", () => {
    const rec = deriveHaltRecommendation({
      recovery_options: CB3_OPTIONS,
      reason: "no_recipe",
      // Exactly what sprint-runner's single deriveNextAction call returns for
      // this halt (next-action.ts:313-318).
      advice: {
        action:
          "No verification recipe could be derived from this working tree, so nothing was verifiable. Point `/ideal` at the sub-project that holds the tests, or declare a build/test command in the project's manifest — a retry re-derives the recipe from the same tree.",
        locus: "recipe",
        sprintCanCarryIt: false,
      },
    } as HaltRecommendationInput);
    expect(rec.index).toBe(1);
    expect(rec.optionId).toBe("point_to_existing");
    expect(rec.kind).toBe("carries-the-fix");
    expect(rec.reason).toContain("Point to existing project");
  });

  it("CB-3 claimed zero_coverage says nothing offered adds tests, and still avoids init_new", () => {
    const rec = deriveHaltRecommendation({
      recovery_options: CB3_OPTIONS,
      advice: {
        action: "Add tests that execute this project's code — the verify recipe REPORTED zero coverage.",
        locus: "code",
        sprintCanCarryIt: true,
      },
    });
    expect(rec.optionId).toBe("point_to_existing");
    expect(rec.kind).toBe("safest-available");
    expect(rec.reason).toContain("Nothing offered carries out the actual fix");
  });

  it("a sprint break pre-selects Resume, never 'Skip verify' or 'Abort run'", () => {
    const withoutAdvice = deriveHaltRecommendation({ recovery_options: SPRINT_FAILED_OPTIONS });
    expect(withoutAdvice.optionId).toBe("resume");
    expect(withoutAdvice.kind).toBe("safest-available");

    const withCodeFix = deriveHaltRecommendation({
      recovery_options: SPRINT_FAILED_OPTIONS,
      advice: advice("code", "Fix the 2 test(s) this sprint broke, then re-run sprint 3."),
    });
    expect(withCodeFix.optionId).toBe("resume");
    expect(withCodeFix.kind).toBe("carries-the-fix");
  });

  it("an all-destructive card pre-selects nothing at all", () => {
    const rec = deriveHaltRecommendation({
      recovery_options: [option("init_new"), option("abort"), option("skip_verify")],
    });
    expect(rec.index).toBe(-1);
    expect(rec.optionId).toBeNull();
    expect(rec.kind).toBe("none");
    expect(rec.reason).toContain("Choose one deliberately");
  });
});
