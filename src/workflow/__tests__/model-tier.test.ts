import { beforeAll, describe, expect, it } from "vitest";
import { getModelInfo, loadCatalog } from "../../models/registry.js";
import {
  buildFlowPerspectiveTaskRequest,
  resolveFlowPerspectiveAgent,
  resolveFlowPremiumModel,
} from "../model-tier.js";

const SESSION_FLASH = "deepseek-v4-flash";

describe("flow model-tier", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("resolveFlowPremiumModel promotes flash session to premium on same provider", () => {
    const premium = resolveFlowPremiumModel(SESSION_FLASH);
    const sessionTier = getModelInfo(SESSION_FLASH)?.tier;
    const premiumTier = getModelInfo(premium)?.tier;
    expect(sessionTier).toBe("fast");
    expect(premiumTier).toBe("premium");
    expect(getModelInfo(premium)?.provider).toBe(getModelInfo(SESSION_FLASH)?.provider);
  });

  it("research perspective uses explore agent with premium model override", () => {
    const req = buildFlowPerspectiveTaskRequest(
      "review plan",
      { id: "research", role: "researcher", mandate: "x", dimension: "grounding" },
      SESSION_FLASH,
    );
    expect(req.agent).toBe("explore");
    expect(req.modelId).toBe(resolveFlowPremiumModel(SESSION_FLASH));
  });

  it("skeptic perspective uses verify agent with premium model override", () => {
    const req = buildFlowPerspectiveTaskRequest(
      "review plan",
      { id: "skeptic", role: "devil's advocate", mandate: "x", dimension: "feasibility" },
      SESSION_FLASH,
    );
    expect(req.agent).toBe("verify");
    expect(req.modelId).toBe(resolveFlowPremiumModel(SESSION_FLASH));
  });

  it("resolveFlowPerspectiveAgent maps research to explore only", () => {
    expect(resolveFlowPerspectiveAgent("research")).toBe("explore");
    expect(resolveFlowPerspectiveAgent("security")).toBe("verify");
    expect(resolveFlowPerspectiveAgent("architect")).toBe("verify");
  });
});
