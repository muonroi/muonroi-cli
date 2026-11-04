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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTestModels, getTestProviders } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { midstreamPolicy } from "../../usage/midstream.js";
import { clearRouteCache, type DecideOpts, decide } from "../decide.js";

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
    clearRouteCache();
    midstreamPolicy.clear();
  });

  it("honours the pin when there is no cap pressure", async () => {
    const dec = await decide("check the weather", { ...BASE_OPTS, forcedModel: "glm-4.7" });
    expect(dec.model).toBe("glm-4.7");
    expect(dec.reason).toBe("project-model-pin");
    expect(dec.model).not.toBe("HALT");
  });
  it("refuses an explicitly selected orchestrator at a zero cap instead of traversing the downgrade chain", async () => {
    const home = mkdtempSync(join(tmpdir(), "orchestrator-cap-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ cap: { monthly_usd: 0 } }));
    try {
      const decision = await decide("Coordinate assigned work", {
        ...BASE_OPTS,
        forcedModel: BASE_OPTS.defaultModel,
        refuseModelSubstitution: true,
        homeOverride: home,
      });
      expect(decision.model).toBe("HALT");
      expect(decision.reason).toContain("requested-model-cap-refusal");
      expect(decision.reason).not.toContain("downgrade");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["fixed", "suggest", "auto"] as const)("%s still respects a cap halt", async (routingMode) => {
    midstreamPolicy.forceRefuseNext();
    const dec = await decide("check weather", { ...BASE_OPTS, routingMode });
    expect(dec.model).toBe("HALT");
    expect(dec.cap_overridden).toBe(true);
  });

  it.each([
    "auto",
    "suggest",
  ] as const)("%s rechecks budget safety when replaying a cached decision", async (routingMode) => {
    const opts: DecideOpts = { ...BASE_OPTS, routingMode, pil: { taskType: "documentation", confidence: 0.9 } };
    expect((await decide("write docs", opts)).model).not.toBe("HALT");
    midstreamPolicy.forceRefuseNext();
    expect((await decide("write docs", opts)).model).toBe("HALT");
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
