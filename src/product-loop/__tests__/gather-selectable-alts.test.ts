/**
 * Sprint D — alternatives in the AskCard are clickable options, not just text.
 *
 * Pre-D: the leader's `alternatives[]` appeared in the question preamble as
 *   "  alt 1: …" lines, but selecting one required choosing the verb
 *   `override` followed by typing the JSON value — equivalent to free-text.
 *
 * Post-D: each alternative becomes its own option labelled
 *   `use alt N: <JSON value>`. Selecting it returns
 *   `{action: "override", value: alt.value}` directly, no manual entry.
 *
 * These tests poke buildGatherUserPrompt with a stubbed `tuiAsk` that asserts
 * the options array shape and returns a chosen label.
 */

import { describe, expect, it, vi } from "vitest";
import type { RecommendOutput } from "../discovery-recommender.js";
import { buildGatherUserPrompt } from "../gather.js";

function makeRec(over: Partial<RecommendOutput> = {}): RecommendOutput {
  return {
    primary: { value: "internal-tool", rationale: "BYOK CLI agent" },
    alternatives: [
      { value: "consumer-app", rationale: "Could be standalone desktop" },
      { value: "saas", rationale: "Could be hosted" },
    ],
    source: "leader",
    costUsd: 0,
    ...over,
  } as RecommendOutput;
}

describe("buildGatherUserPrompt — selectable alternatives", () => {
  it("offers accept + every alternative + custom + skip + abort", async () => {
    let capturedOptions: string[] | undefined;
    const tuiAsk = vi.fn(async (_label: string, options?: string[]) => {
      capturedOptions = options;
      return "skip"; // bail out
    });
    const prompt = buildGatherUserPrompt(tuiAsk);
    await prompt({ questionId: "productType", recommendation: makeRec() });
    expect(capturedOptions).toEqual([
      "accept",
      'use alt 1: "consumer-app"',
      'use alt 2: "saas"',
      "custom value",
      "skip",
      "abort",
    ]);
  });

  it('selecting "use alt 1: …" returns override with that alt.value', async () => {
    const tuiAsk = vi.fn(async (_label: string, _options?: string[]) => 'use alt 1: "consumer-app"');
    const prompt = buildGatherUserPrompt(tuiAsk);
    const result = await prompt({ questionId: "productType", recommendation: makeRec() });
    expect(result).toMatchObject({ action: "override", value: "consumer-app" });
    expect(tuiAsk).toHaveBeenCalledTimes(1); // no manual entry follow-up
  });

  it('selecting "use alt 2: …" returns the second alt value', async () => {
    const tuiAsk = vi.fn(async (_label: string, _options?: string[]) => 'use alt 2: "saas"');
    const prompt = buildGatherUserPrompt(tuiAsk);
    const result = await prompt({ questionId: "productType", recommendation: makeRec() });
    expect(result).toMatchObject({ action: "override", value: "saas" });
  });

  it('selecting "custom value" still falls through to manual JSON entry', async () => {
    const replies = ["custom value", '"power-user-tool"', "wanted something else"];
    const tuiAsk = vi.fn(async () => replies.shift() ?? "");
    const prompt = buildGatherUserPrompt(tuiAsk);
    const result = await prompt({ questionId: "productType", recommendation: makeRec() });
    expect(result).toMatchObject({ action: "override", value: "power-user-tool" });
    expect(tuiAsk).toHaveBeenCalledTimes(3); // card + value + reason
  });

  it("when there are no alternatives, only accept + custom + skip + abort are offered", async () => {
    let capturedOptions: string[] | undefined;
    const tuiAsk = vi.fn(async (_label: string, options?: string[]) => {
      capturedOptions = options;
      return "skip";
    });
    const prompt = buildGatherUserPrompt(tuiAsk);
    await prompt({ questionId: "productType", recommendation: makeRec({ alternatives: [] }) });
    expect(capturedOptions).toEqual(["accept", "custom value", "skip", "abort"]);
  });

  it("when leader returned no primary (user-only), accept is hidden", async () => {
    let capturedOptions: string[] | undefined;
    const tuiAsk = vi.fn(async (_label: string, options?: string[]) => {
      capturedOptions = options;
      return "skip";
    });
    const prompt = buildGatherUserPrompt(tuiAsk);
    await prompt({
      questionId: "productType",
      recommendation: {
        primary: { value: null, rationale: "leader unavailable" },
        alternatives: [],
        source: "user-only",
        costUsd: 0,
      } as RecommendOutput,
    });
    expect(capturedOptions).toEqual(["custom value", "skip", "abort"]);
  });

  it('accept still works: returns {action:"accept"}', async () => {
    const tuiAsk = vi.fn(async () => "accept");
    const prompt = buildGatherUserPrompt(tuiAsk);
    const result = await prompt({ questionId: "productType", recommendation: makeRec() });
    expect(result).toEqual({ action: "accept" });
  });

  it('abort returns {action:"abort"} and skip returns {action:"skip"}', async () => {
    const prompt1 = buildGatherUserPrompt(vi.fn(async () => "abort"));
    expect(await prompt1({ questionId: "x", recommendation: makeRec() })).toEqual({ action: "abort" });
    const prompt2 = buildGatherUserPrompt(vi.fn(async () => "skip"));
    expect(await prompt2({ questionId: "x", recommendation: makeRec() })).toEqual({ action: "skip" });
  });
});
