// src/ee/who-am-i-brain.test.ts
//
// Brain-derived "Who Am I" for thin-clients. The device-local profile.yaml pipeline
// is full-brain-only (interceptor-prompt.js `if (isRemoteMode()) return`), so on a
// thin-client getWhoAmIProfile() is always null. These tests cover the fallback that
// derives the same WhoAmIProfile shape from the reachable `experience-behavioral`
// brain — search the user's own working-style rules, let the brain LLM classify them
// into privacy-gated dims (agent-first, no keyword regex), reuse selectWhoAmIDims for
// the allowlist + confidence floor. Fail-open: any gap → null → PIL keeps its default.

import { afterEach, describe, expect, it, vi } from "vitest";
import { outputStyleFromProfile } from "./who-am-i.js";
import {
  type BrainWhoAmIDeps,
  buildStyleClassifyPrompt,
  deriveWhoAmIFromBrain,
  isBrainWhoAmIEnabled,
  parseBrainProfile,
} from "./who-am-i-brain.js";

function depsFrom(rules: string[], classifyOut: string | null): BrainWhoAmIDeps {
  return {
    searchByText: vi.fn(async () => rules.map((text) => ({ payload: { text } }))),
    classifyViaBrain: vi.fn(async () => classifyOut),
  };
}

const GOOD_JSON = JSON.stringify({
  dimensions: {
    "communication.brevity": { value: "concise", confidence: 0.82, sampleCount: 4 },
    "personality.decision_speed": { value: "fast-intuitive", confidence: 0.78, sampleCount: 3 },
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MUONROI_WHOAMI_BRAIN;
});

describe("isBrainWhoAmIEnabled — default ON, opt-out with =0", () => {
  it("is enabled by default", () => {
    delete process.env.MUONROI_WHOAMI_BRAIN;
    expect(isBrainWhoAmIEnabled()).toBe(true);
  });
  it("is disabled when MUONROI_WHOAMI_BRAIN=0", () => {
    process.env.MUONROI_WHOAMI_BRAIN = "0";
    expect(isBrainWhoAmIEnabled()).toBe(false);
  });
});

describe("buildStyleClassifyPrompt", () => {
  it("embeds the retrieved rules and asks for the dim JSON schema", () => {
    const p = buildStyleClassifyPrompt(["recommend, don't ask", "keep replies concise"]);
    expect(p).toContain("recommend, don't ask");
    expect(p).toContain("keep replies concise");
    // must name the JSON contract + at least one allowed dim name
    expect(p).toMatch(/dimensions/);
    expect(p).toContain("communication.brevity");
  });
  it("returns a probe-only prompt when there are no rules (still valid)", () => {
    const p = buildStyleClassifyPrompt([]);
    expect(p).toMatch(/dimensions/);
  });

  it("offers the EXACT values the PIL layers compare against (lever-alignment guard)", () => {
    // These literals are consumed verbatim by the layers — if the vocab drifts, the
    // dim gets populated but the lever never fires. Locks the EE-contract vocab.
    const p = buildStyleClassifyPrompt(["x"]);
    expect(p).toContain("autonomous"); // layer4-gsd delegation_style
    expect(p).toContain("precise-correction"); // layer6-output feedback_style
    expect(p).toContain("fast-intuitive"); // outputStyleFromProfile decision_speed
    expect(p).toMatch(/"long"/); // layer5-context session_length
  });
});

describe("parseBrainProfile", () => {
  it("maps a well-formed JSON to a privacy-gated profile at standard tier", () => {
    const prof = parseBrainProfile(GOOD_JSON, "standard");
    expect(prof).not.toBeNull();
    expect(prof?.dims["communication.brevity"]?.value).toBe("concise");
    expect(outputStyleFromProfile(prof)).toBe("concise");
  });

  it("tolerates a ```json fenced block wrapped in prose (brain LLM output)", () => {
    const noisy = "Sure! Here is the profile:\n```json\n" + GOOD_JSON + "\n```\nHope that helps.";
    const prof = parseBrainProfile(noisy, "standard");
    expect(prof?.dims["communication.brevity"]?.value).toBe("concise");
  });

  it("drops dims below the per-tier confidence floor", () => {
    const lowConf = JSON.stringify({
      dimensions: { "communication.brevity": { value: "concise", confidence: 0.2, sampleCount: 1 } },
    });
    expect(parseBrainProfile(lowConf, "standard")).toBeNull();
  });

  it("preserves an 'autonomous' delegation value so layer4 can fire on it", () => {
    const json = JSON.stringify({
      dimensions: { "work_patterns.delegation_style": { value: "autonomous", confidence: 0.8, sampleCount: 3 } },
    });
    const prof = parseBrainProfile(json, "standard");
    expect(prof?.dims["work_patterns.delegation_style"]?.value).toBe("autonomous");
  });

  it("drops an off-vocabulary value (weak-model typo, e.g. 'precice-correction')", () => {
    const typo = JSON.stringify({
      dimensions: { "communication.feedback_style": { value: "precice-correction", confidence: 0.95, sampleCount: 6 } },
    });
    // Populated dim name is allowlisted, but the misspelled value can never fire the
    // literal `=== "precise-correction"` lever → must be dropped, not surfaced.
    expect(parseBrainProfile(typo, "standard")).toBeNull();
  });

  it("never surfaces a non-allowlisted dim (e.g. emotional.*)", () => {
    const leaky = JSON.stringify({
      dimensions: { "emotional.stress_response": { value: "calm", confidence: 0.9, sampleCount: 5 } },
    });
    expect(parseBrainProfile(leaky, "standard")).toBeNull();
  });

  it("returns null on unparseable garbage (fail-open)", () => {
    expect(parseBrainProfile("not json at all {oops", "standard")).toBeNull();
    expect(parseBrainProfile("", "standard")).toBeNull();
  });
});

describe("deriveWhoAmIFromBrain", () => {
  it("returns null when the behavioral brain returns no rules", async () => {
    const deps = depsFrom([], GOOD_JSON);
    expect(await deriveWhoAmIFromBrain(deps)).toBeNull();
    // must not waste an LLM call when there is nothing to classify
    expect(deps.classifyViaBrain).not.toHaveBeenCalled();
  });

  it("returns null when the brain classifier yields nothing", async () => {
    const deps = depsFrom(["recommend, don't ask"], null);
    expect(await deriveWhoAmIFromBrain(deps)).toBeNull();
  });

  it("derives a concise-style profile end-to-end from rules", async () => {
    const deps = depsFrom(["recommend, don't ask", "keep replies concise"], GOOD_JSON);
    const prof = await deriveWhoAmIFromBrain(deps);
    expect(prof?.dims["communication.brevity"]?.value).toBe("concise");
    expect(outputStyleFromProfile(prof)).toBe("concise");
    expect(deps.searchByText).toHaveBeenCalledWith(expect.any(String), ["experience-behavioral"], expect.any(Number));
  });

  it("passes a systemPrompt override to the brain (else the tier-classifier default mangles JSON)", async () => {
    // Regression guard: the EE brain proxy's default system prompt tells the model to
    // output one word and ignore content. Verified on the live VPS that omitting the
    // override produces garbage JSON. The call MUST supply systemPrompt + json format.
    const deps = depsFrom(["keep replies concise"], GOOD_JSON);
    await deriveWhoAmIFromBrain(deps);
    const opts = (deps.classifyViaBrain as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | { systemPrompt?: string; responseFormat?: { type: string }; useExtractModel?: boolean }
      | undefined;
    expect(opts?.systemPrompt).toBeTruthy();
    expect(opts?.responseFormat).toEqual({ type: "json_object" });
    // Must request the server's strong extract model — the hot-path model mis-spells vocab.
    expect(opts?.useExtractModel).toBe(true);
  });

  it("is fail-open: a throwing search dep degrades to null, never throws", async () => {
    const deps: BrainWhoAmIDeps = {
      searchByText: vi.fn(async () => {
        throw new Error("brain down");
      }),
      classifyViaBrain: vi.fn(async () => GOOD_JSON),
    };
    await expect(deriveWhoAmIFromBrain(deps)).resolves.toBeNull();
  });
});
