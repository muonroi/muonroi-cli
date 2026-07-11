/**
 * #3 — grounding-verify pass. When a debate ends with weak evidence density
 * (debaters barely tagged claims, since each is capped at stepCountIs(2)), an
 * isolated explore sub-agent fact-checks the load-bearing claims and emits
 * [CONFIRMED via …]/[REFUTED via …] tags that raise the density metric council
 * uses for confidence. These guard the sub-agent request shape, the "" failure
 * contract, the enable flag, and the density-raising invariant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeEvidenceDensity, countCitations, groundingVerifyEnabled, runGroundingVerify } from "../debate.js";

describe("#3 runGroundingVerify", () => {
  it("returns the tagged output and requests a read-only explore agent pinned to the model", async () => {
    const runIsolatedTask = vi.fn().mockResolvedValue({
      success: true,
      output: "## Grounding Check\n- registry has 3 branches [CONFIRMED via registry.ts:561]",
    });
    const out = await runGroundingVerify(runIsolatedTask, "leader-model", "problem?", "debater said X", () => {});
    expect(out).toContain("[CONFIRMED via registry.ts:561]");
    const req = runIsolatedTask.mock.calls[0][0];
    expect(req.agent).toBe("explore");
    expect(req.modelId).toBe("leader-model");
    expect(req.prompt).toContain("CONFIRMED");
    expect(req.prompt).toContain("REFUTED");
  });

  it("returns '' on failure (so the caller folds nothing in)", async () => {
    const runIsolatedTask = vi.fn().mockResolvedValue({ success: false, error: "boom" });
    expect(await runGroundingVerify(runIsolatedTask, "m", "p", "x", () => {})).toBe("");
  });

  it("returns '' when the isolated task throws", async () => {
    const runIsolatedTask = vi.fn().mockRejectedValue(new Error("nope"));
    expect(await runGroundingVerify(runIsolatedTask, "m", "p", "x", () => {})).toBe("");
  });

  it("folding verified tags into the density input raises evidence density from 0", () => {
    // A debate with no tags → density 0. The verify pass adds two CONFIRMED tags.
    const exchange = "Debater A: I think we should remove Plan mode.\nDebater B: Agreed, seems redundant.";
    expect(computeEvidenceDensity(exchange)).toBe(0);
    const verify =
      "## Grounding Check\n- Plan/Ask share a boundary [CONFIRMED via registry.ts:561]\n- no output-shape signal [CONFIRMED via prompts.ts:88]";
    const combined = `${exchange}\n\n${verify}`;
    expect(countCitations(combined)).toBe(2);
    expect(computeEvidenceDensity(combined)).toBe(1); // 2 cited / (2 cited + 0 unverified)
  });
});

describe("#3 groundingVerifyEnabled", () => {
  const prev = process.env.MUONROI_COUNCIL_GROUNDING_VERIFY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_COUNCIL_GROUNDING_VERIFY;
    else process.env.MUONROI_COUNCIL_GROUNDING_VERIFY = prev;
  });

  it("defaults ON", () => {
    delete process.env.MUONROI_COUNCIL_GROUNDING_VERIFY;
    expect(groundingVerifyEnabled()).toBe(true);
  });

  it("opts out with =0", () => {
    process.env.MUONROI_COUNCIL_GROUNDING_VERIFY = "0";
    expect(groundingVerifyEnabled()).toBe(false);
  });
});
