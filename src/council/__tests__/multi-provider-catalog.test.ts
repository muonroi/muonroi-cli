import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../providers/keychain.js", () => ({
  getConfiguredProviders: vi.fn(async () => ["deepseek", "zai", "opencode-go"]),
}));

vi.mock("../../utils/settings.js", () => ({
  getRoleModels: () => ({}),
  getRoleModel: () => undefined,
  isProviderDisabled: () => false,
}));

import { loadCatalog } from "../../models/registry.js";
import { detectProviderForModel } from "../../providers/runtime.js";
import { getEffectiveCouncilRoleCount, resolveParticipants } from "../leader.js";

describe("catalog multi-provider council", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("getEffectiveCouncilRoleCount uses catalog slots when roleModels unset", () => {
    expect(getEffectiveCouncilRoleCount()).toBe(3);
  });

  it("resolveParticipants spreads roles across deepseek, zai, opencode-go", async () => {
    const participants = await resolveParticipants("glm-4.7", true);
    expect(participants.length).toBe(3);
    const byRole = Object.fromEntries(participants.map((p) => [p.role, p.model]));
    expect(byRole.implement).toBe("deepseek-v4-flash");
    expect(byRole.verify).toBe("glm-5.2");
    expect(byRole.research).toBe("opencode/kimi-k2.7-code");
    const providers = new Set(participants.map((p) => detectProviderForModel(p.model)));
    expect(providers).toEqual(new Set(["deepseek", "zai", "opencode-go"]));
  });

  it("falls back to same-provider when multi-provider disabled", async () => {
    const participants = await resolveParticipants("glm-4.7", false);
    expect(participants.length).toBeGreaterThanOrEqual(2);
    for (const p of participants) {
      expect(p.model).toMatch(/glm-/);
    }
  });
});
