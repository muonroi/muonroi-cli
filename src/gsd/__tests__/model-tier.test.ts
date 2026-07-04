import { beforeAll, describe, expect, it } from "vitest";
import { getModelInfo, loadCatalog } from "../../models/registry.js";
import { buildGsdPerspectiveTaskRequest, resolveGsdPerspectiveAgent, resolveGsdPremiumModel } from "../model-tier.js";

const SESSION_FLASH = "deepseek-v4-flash";

describe("gsd model-tier", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("resolveGsdPremiumModel promotes flash session to premium on same provider", () => {
    const premium = resolveGsdPremiumModel(SESSION_FLASH);
    const sessionTier = getModelInfo(SESSION_FLASH)?.tier;
    const premiumTier = getModelInfo(premium)?.tier;
    expect(sessionTier).toBe("fast");
    expect(premiumTier).toBe("premium");
    expect(getModelInfo(premium)?.provider).toBe(getModelInfo(SESSION_FLASH)?.provider);
  });

  it("research perspective uses explore agent with premium model override", () => {
    const req = buildGsdPerspectiveTaskRequest(
      "review plan",
      { id: "research", role: "researcher", mandate: "x" },
      SESSION_FLASH,
    );
    expect(req.agent).toBe("explore");
    expect(req.modelId).toBe(resolveGsdPremiumModel(SESSION_FLASH));
  });

  it("skeptic perspective uses verify agent with premium model override", () => {
    const req = buildGsdPerspectiveTaskRequest(
      "review plan",
      { id: "skeptic", role: "devil's advocate", mandate: "x" },
      SESSION_FLASH,
    );
    expect(req.agent).toBe("verify");
    expect(req.modelId).toBe(resolveGsdPremiumModel(SESSION_FLASH));
  });

  it("resolveGsdPerspectiveAgent maps research to explore only", () => {
    expect(resolveGsdPerspectiveAgent("research")).toBe("explore");
    expect(resolveGsdPerspectiveAgent("security")).toBe("verify");
    expect(resolveGsdPerspectiveAgent("architect")).toBe("verify");
  });
});
