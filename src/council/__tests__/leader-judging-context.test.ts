import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLeaderEvidenceBundle, buildPriorVerdicts } from "../debate.js";
import { buildLeaderEvaluationPrompt, type LeaderPriorVerdict } from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

/**
 * The leader grades every round with a real model call and its verdict drives the
 * run. It was judging on a structurally insufficient view:
 *
 *  B1 — it had no memory of its OWN prior verdicts. `evaluateDebate` never
 *       received `lastCriteriaMet`; the caller used it only to build the
 *       directive string. Each round re-derived every criterion from scratch.
 *  B2 — its entire evidence window was `exchangeLogs.flat().slice(-8)`. Every
 *       panelist got `runningSummary`; the one grading the debate did not.
 *  B3 — per-round content must stay in the prompt TAIL or the cacheable `system`
 *       prefix busts on every leader evaluation.
 *
 * Together B1+B2 produced the reported symptom (live session 98c8293f6d04, "Criteria
 * 0/3" for several rounds): a criterion marked MET in round 2 silently regressed
 * once its supporting exchange scrolled out of the 8-chunk tail.
 */

const spec = {
  problemStatement: "Detect rule violations",
  successCriteria: ["Detects violations", "Shows a warning", "Applies principles consistently"],
  // extractStackFromSpec reads constraints/scope; omitting them throws in the
  // stack-lock builder, which is unrelated to what this file pins.
  constraints: [],
  scope: "",
} as unknown as ClarifiedSpec;

const priorVerdicts: LeaderPriorVerdict[] = [
  { criterion: "Detects violations", met: true, deferred: false, evidence: "Architect cited the AST walker" },
  { criterion: "Shows a warning", met: false, deferred: false, evidence: "nobody addressed the surface" },
  { criterion: "Applies principles consistently", met: false, deferred: true, evidence: "needs the code landed" },
];

describe("B1 — the leader sees its own prior verdict", () => {
  it("renders last round's per-criterion verdict AND the reason it gave", () => {
    const { prompt } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: "…", round: 3, priorVerdicts });

    expect(prompt).toContain("Your verdict last round (Round 2)");
    // The verdict itself…
    expect(prompt).toContain("[MET] Detects violations");
    expect(prompt).toContain("[OPEN] Shows a warning");
    expect(prompt).toContain("[DEFERRED (closable only after the debate)] Applies principles consistently");
    // …and the reasoning behind it, which is what makes a verdict defensible
    // instead of re-rolled.
    expect(prompt).toContain("Architect cited the AST walker");
    expect(prompt).toContain("nobody addressed the surface");
  });

  it("instructs that a MET→not-met reversal must name what un-did it", () => {
    const { system } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: "…", round: 3, priorVerdicts });
    expect(system).toContain("Continuity with your own prior verdict");
    expect(system).toMatch(/previously marked MET may be marked not-met again ONLY if you state/);
    // An unexplained regression is the defect, not an acceptable output.
    expect(system).toMatch(/grading error, not a valid outcome/);
  });

  it("renders nothing on round 1, and nothing when no criteria are pinned", () => {
    expect(buildLeaderEvaluationPrompt({ spec, exchangeLogs: "…", round: 1, priorVerdicts }).prompt).not.toContain(
      "Your verdict last round",
    );
    expect(buildLeaderEvaluationPrompt({ spec, exchangeLogs: "…", round: 4 }).prompt).not.toContain(
      "Your verdict last round",
    );
  });

  it("buildPriorVerdicts pairs each pinned criterion with its flags and reason", () => {
    const built = buildPriorVerdicts(
      spec.successCriteria,
      [true, false, false],
      [false, false, true],
      ["because X", "", ""],
    );
    expect(built).toEqual(priorVerdicts.map((v, i) => ({ ...v, evidence: ["because X", "", ""][i] })));
    // Round 1: no evaluation has landed, so there is nothing to carry.
    expect(buildPriorVerdicts(spec.successCriteria, [], [], [])).toEqual([]);
  });
});

describe("B2 — the judge is given the debate, not just its tail", () => {
  const chunk = (i: number) => `[Architect] turn ${i}: ${"x".repeat(200)}`;

  it("includes the condensed state every other participant already receives", () => {
    const bundle = buildLeaderEvidenceBundle({
      exchanges: [chunk(1), chunk(2)],
      runningSummary: "Both agreed the AST walker covers detection.",
    });
    expect(bundle).toContain("Discussion state so far");
    expect(bundle).toContain("Both agreed the AST walker covers detection.");
  });

  it("never shows the judge LESS than the 8-chunk tail it saw before", () => {
    // Each chunk here is far over the per-chunk share of the budget; the floor
    // must still hold, or a debate with long turns would regress.
    const long = Array.from({ length: 12 }, (_, i) => `[Reviewer] turn ${i}: ${"y".repeat(9_000)}`);
    const bundle = buildLeaderEvidenceBundle({ exchanges: long });
    for (const c of long.slice(-8)) expect(bundle).toContain(c);
  });

  it("widens backwards past the 8-chunk tail while the char budget allows", () => {
    const many = Array.from({ length: 30 }, (_, i) => chunk(i));
    const bundle = buildLeaderEvidenceBundle({ exchanges: many });
    // The old window would have cut everything before turn 22.
    expect(bundle).toContain(chunk(5));
    expect(bundle).toContain(chunk(29));
  });

  it("stays inside its char budget and says what it omitted", () => {
    const many = Array.from({ length: 400 }, (_, i) => chunk(i));
    const bundle = buildLeaderEvidenceBundle({ exchanges: many, runningSummary: "z".repeat(50_000) });
    // 6_000 summary + 18_000 verbatim, plus the short section headers.
    expect(bundle.length).toBeLessThan(25_000);
    expect(bundle).toContain("summary truncated");
    expect(bundle).toMatch(/earlier turn\(s\) covered by the condensed state above/);
  });
});

describe("B3 — per-round content stays in the tail, so `system` stays cacheable", () => {
  it("keeps the prior-verdict data out of `system` and byte-stable across rounds", () => {
    const r2 = buildLeaderEvaluationPrompt({ spec, exchangeLogs: "round 2 text", round: 2, priorVerdicts });
    const r5 = buildLeaderEvaluationPrompt({
      spec,
      exchangeLogs: "round 5 text",
      round: 5,
      priorVerdicts: priorVerdicts.map((v) => ({ ...v, met: !v.met, evidence: "something else entirely" })),
    });
    expect(r5.system).toBe(r2.system);
    // The static rule NAMES the tail block (that is how the model finds it), but
    // none of the per-round data may appear here.
    expect(r2.system).not.toContain("[MET] Detects violations");
    expect(r2.system).not.toContain("Architect cited the AST walker");
    expect(r2.system).not.toContain("Round 1)");
    // The tail is where the round differs.
    expect(r2.prompt).not.toBe(r5.prompt);
  });
});

describe("the call site, not just the builders", () => {
  // The trap this file exists to avoid: a prompt-BUILDER test passes even when
  // debate.ts never hands the new data over. That is exactly how the leader's
  // directive stayed undelivered for so long.
  const src = readFileSync(resolve("src/council/debate.ts"), "utf8");
  const lines = src.split(/\r?\n/);

  it("passes priorVerdicts at BOTH evaluateDebate call sites (primary + fallback)", () => {
    // Read the actual argument lists, not a bare substring count — the builder
    // call and the function signature also mention the name.
    const callArgs = [...src.matchAll(/yield\* evaluateDebate\(([\s\S]*?)\n\s*\);/g)].map((m) => m[1]);
    expect(callArgs.length).toBe(2);
    for (const args of callArgs) expect(args).toMatch(/\bpriorVerdicts,/);
    // …and they are built from the state as it stood ENTERING the round.
    expect(src).toContain("const priorVerdicts = buildPriorVerdicts(");
  });

  it("refreshes the per-criterion reason each round, or the block would go stale", () => {
    expect(src).toContain("lastCriteriaEvidence = alignCriteriaEvidence(");
  });

  it("assembles the judging bundle instead of the bare 8-chunk tail", () => {
    expect(src).toContain("buildLeaderEvidenceBundle({ exchanges: flatExchanges, runningSummary })");
    // The old primary path must be gone — it survives only inside the fail-open
    // catch, which is what the `console.error` line above it marks.
    const tailUses = lines.filter((l) => l.includes(".slice(-8).join("));
    expect(tailUses.length).toBe(1);
    expect(tailUses[0]).toContain("flatExchanges");
  });

  it("keeps the verdict a replacement, not an OR-accumulation ratchet", () => {
    // A ratchet would make a genuine regression inexpressible; the regression is
    // fixed at its cause (B1+B2), not by latching the flag true. Pin the code AND
    // the recorded reason, so a future reader does not "helpfully" add one.
    expect(src).toContain("lastCriteriaMet = aligned;");
    expect(src).toContain("OR-accumulation ratchet");
    expect(src).toMatch(/Rejected\./);
  });
});
