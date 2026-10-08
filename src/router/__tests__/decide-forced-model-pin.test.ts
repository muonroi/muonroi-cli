/**
 * Round 2, HIGH finding: message-processor.ts used to skip `decide()`
 * ENTIRELY for a project-pinned main turn, which also skipped the cap/budget
 * reservation + downgrade-chain/halt check (`capCheck`) every other decision
 * goes through — a cap breach on a pinned turn was silently invisible to the
 * router. Fix: `decide(prompt, { ...opts, forcedModel })` still runs the
 * classifier-free "project-pin" decision through the SAME `capCheck` any
 * other RouteDecision goes through; only the free model CHOICE (role/PIL/
 * hot/warm/cold classification) is skipped.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTestModels, getTestProviders } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { midstreamPolicy } from "../../usage/midstream.js";
import { type DecideOpts, decide } from "../decide.js";

describe("decide() — forcedModel (project model pin) keeps cap checks", () => {
  let BASE_OPTS: DecideOpts;

  beforeAll(async () => {
    await loadCatalog();
    getTestModels();
    getTestProviders();
    BASE_OPTS = {
      tenantId: "default",
      cwd: "/tmp",
      defaultModel: "glm-4.7",
      defaultProvider: "zai",
    };
  });

  afterEach(() => {
    midstreamPolicy.clear();
  });

  it("honours the pin when there is no cap pressure", async () => {
    const dec = await decide("check the weather", { ...BASE_OPTS, forcedModel: "glm-4.7" });
    expect(dec.model).toBe("glm-4.7");
    expect(dec.reason).toBe("project-model-pin");
    expect(dec.model).not.toBe("HALT");
  });

  it("BUG FIX: a cap breach (midstream refuse-next already tripped) still HALTs a pinned turn", async () => {
    // `midstreamPolicy.refuseNext()` is the very first check inside capCheck's
    // downgrade loop — forcing it true reproduces "the monthly cap already
    // breached earlier this session" without needing to fabricate ledger
    // usage state. Skipping decide() entirely (the pre-fix behavior) could
    // never reach this check at all for a pinned turn.
    midstreamPolicy.forceRefuseNext();
    const dec = await decide("check the weather", { ...BASE_OPTS, forcedModel: "glm-4.7" });
    expect(dec.model).toBe("HALT");
    expect(dec.tier).toBe("degraded");
    expect(dec.cap_overridden).toBe(true);
    expect(dec.reason).toContain("cap-halt");
  });

  it("does not run the classifier ladder at all when forcedModel is set (pin is authoritative)", async () => {
    // A prompt shaped to obviously classify as something else entirely — if
    // the classifier ladder ran, `dec.model` would very likely differ from
    // the pin. reason === "project-model-pin" (not a pil:/role:/EE-sourced
    // reason) is the direct proof the ladder was bypassed.
    const dec = await decide("please refactor this entire codebase for performance", {
      ...BASE_OPTS,
      forcedModel: "glm-4.7",
      pil: { taskType: "refactor", confidence: 0.99 },
    });
    expect(dec.model).toBe("glm-4.7");
    expect(dec.reason).toBe("project-model-pin");
  });
});
