/**
 * C2 — per-round item scoping, prompt-builder level.
 *
 * `runDebate`'s round loop narrows one round to a single C1-selected item by
 * threading an optional `focus` field through `buildResponsePrompt`,
 * `buildFollowupPrompt` and `buildLeaderEvaluationPrompt` (debate.ts). This
 * suite pins the byte-identity guarantee those three builders must keep when
 * `focus` is omitted — the ONE thing that makes the engine-level "no
 * override" behavior in debate-item-focus.test.ts provably safe: every
 * round-loop call site passes `focus: roundItemFocus?.text`, so if
 * `perRoundFocus` is absent/empty, `roundItemFocus` is always undefined and
 * every one of these calls degrades to the exact no-`focus` case pinned here.
 */
import { describe, expect, it } from "vitest";
import { buildFollowupPrompt, buildLeaderEvaluationPrompt, buildResponsePrompt } from "../prompts.js";
import type { ClarifiedSpec } from "../types.js";

const spec: ClarifiedSpec = {
  problemStatement: "Decide the caching policy for the payments service.",
  constraints: ["Must not add a new infra dependency."],
  successCriteria: ["Cache invalidation is correct under concurrent writes."],
  scope: "backend",
  rawQA: [],
} as unknown as ClarifiedSpec;

const FOCUS_TEXT =
  "[step3] Wire the payment webhook\nWhy this item was selected (task-deviation): signature check missing.";

describe("buildResponsePrompt — focus (C2)", () => {
  const base = {
    speakerRole: "architect",
    partnerRole: "skeptic",
    speakerPosition: "My opening position.",
    partnerPosition: "Their opening position.",
    spec,
    language: "auto",
  } as const;

  it("omitting focus produces a prompt byte-identical to explicit focus:undefined", () => {
    const omitted = buildResponsePrompt({ ...base });
    const explicitUndefined = buildResponsePrompt({ ...base, focus: undefined });
    expect(omitted).toEqual(explicitUndefined);
  });

  it("never touches system regardless of focus", () => {
    const noFocus = buildResponsePrompt({ ...base });
    const withFocus = buildResponsePrompt({ ...base, focus: FOCUS_TEXT });
    expect(withFocus.system).toBe(noFocus.system);
  });

  it("prepends the focus text to prompt, additively, when set", () => {
    const noFocus = buildResponsePrompt({ ...base });
    const withFocus = buildResponsePrompt({ ...base, focus: FOCUS_TEXT });
    expect(withFocus.prompt).toContain(FOCUS_TEXT);
    expect(withFocus.prompt).toContain(noFocus.prompt); // shared content still present, not replaced.
    expect(withFocus.prompt).not.toBe(noFocus.prompt);
  });
});

describe("buildFollowupPrompt — focus (C2)", () => {
  const base = {
    speakerRole: "architect",
    partnerRole: "skeptic",
    partnerPosition: "Their latest.",
    speakerLastPosition: "Mine.",
    round: 2,
    runningSummary: "AGREED: use write-through caching.",
    spec,
    language: "auto",
  } as const;

  it("omitting focus produces a prompt byte-identical to explicit focus:undefined", () => {
    const omitted = buildFollowupPrompt({ ...base });
    const explicitUndefined = buildFollowupPrompt({ ...base, focus: undefined });
    expect(omitted).toEqual(explicitUndefined);
  });

  it("keeps the cacheable system prefix byte-identical across rounds regardless of focus", () => {
    // The whole point of the tail-only placement: system must not vary with
    // round number NOR with a per-round focus, or the provider prompt cache
    // misses on every scoped round.
    const r2NoFocus = buildFollowupPrompt({ ...base, round: 2 });
    const r5WithFocus = buildFollowupPrompt({ ...base, round: 5, focus: FOCUS_TEXT });
    expect(r5WithFocus.system).toBe(r2NoFocus.system);
  });

  it("adds the focus block to the prompt tail, additively, when set", () => {
    const noFocus = buildFollowupPrompt({ ...base });
    const withFocus = buildFollowupPrompt({ ...base, focus: FOCUS_TEXT });
    expect(withFocus.prompt).toContain("## This round's item focus");
    expect(withFocus.prompt).toContain(FOCUS_TEXT);
    expect(withFocus.prompt).toContain(noFocus.prompt);
  });
});

describe("buildLeaderEvaluationPrompt — focus (C2)", () => {
  const base = {
    spec,
    exchangeLogs: "[architect]: We should cache aggressively.\n[skeptic]: That risks stale reads.",
    round: 2,
    language: "auto",
    participants: ["architect", "skeptic"],
  } as const;

  it("omitting focus produces a prompt byte-identical to explicit focus:undefined", () => {
    const omitted = buildLeaderEvaluationPrompt({ ...base });
    const explicitUndefined = buildLeaderEvaluationPrompt({ ...base, focus: undefined });
    expect(omitted).toEqual(explicitUndefined);
  });

  it("never touches system regardless of focus (leader-eval system must stay round-stable too)", () => {
    const noFocus = buildLeaderEvaluationPrompt({ ...base });
    const withFocus = buildLeaderEvaluationPrompt({ ...base, focus: FOCUS_TEXT });
    expect(withFocus.system).toBe(noFocus.system);
  });

  it("adds the focus block to the prompt tail, additively, when set", () => {
    const noFocus = buildLeaderEvaluationPrompt({ ...base });
    const withFocus = buildLeaderEvaluationPrompt({ ...base, focus: FOCUS_TEXT });
    expect(withFocus.prompt).toContain("## This round's item focus");
    expect(withFocus.prompt).toContain(FOCUS_TEXT);
    expect(withFocus.prompt).toContain(noFocus.prompt);
  });
});
