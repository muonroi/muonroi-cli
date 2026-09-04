/**
 * role-assignment-disabled-provider.test.ts — P0-1 root cause.
 *
 * `resolveRoleAssignments` built its model inventory from "every provider that
 * has a key on the keychain" and was the ONLY model selector in the codebase
 * that did NOT also consult `isProviderDisabled` (compare
 * council/leader.ts `resolveParticipants`:322/337/343 and
 * `buildCouncilCandidatePool`:388). A stale key for a provider the user had
 * switched OFF therefore still won a role slot.
 *
 * That is fatal, not cosmetic. sprint-runner.ts:799 uses
 * `roleAssignments.get("Architect").modelId` as the SESSION MODEL of the
 * per-sprint planning council, and `resolveParticipants` returns `[]` for a
 * disabled provider — so `runCouncil` bailed with "No reachable provider" on
 * every sprint. Measured live 2026-09-04 with
 * `disabledProviders: ["xai","zai","opencode-go","deepseek"]` and a stale
 * opencode-go key present: Architect resolved to `opencode/glm-5.1` and
 * `resolveParticipants("opencode/glm-5.1", false)` returned 0 participants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disabled = new Set<string>();
const keyed = new Set<string>();

vi.mock("../../utils/settings.js", () => ({
  isProviderDisabled: (p: string) => disabled.has(p),
}));
vi.mock("../../providers/keychain.js", () => ({
  loadKeyForProvider: async (p: string) => {
    if (!keyed.has(p)) throw new Error(`no key for ${p}`);
    return "sk-test";
  },
}));
vi.mock("../../models/registry.js", () => ({
  getModelsForProvider: (p: string) =>
    [
      { id: `${p}/premium-a`, provider: p, tier: "premium" },
      { id: `${p}/premium-b`, provider: p, tier: "premium" },
      { id: `${p}/balanced-a`, provider: p, tier: "balanced" },
      { id: `${p}/balanced-b`, provider: p, tier: "balanced" },
      { id: `${p}/fast-a`, provider: p, tier: "fast" },
      { id: `${p}/fast-b`, provider: p, tier: "fast" },
    ] as unknown[],
}));
vi.mock("../../ee/bridge.js", () => ({ routeModel: async () => null }));

import { resolveRoleAssignments } from "../index.js";

beforeEach(() => {
  disabled.clear();
  keyed.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveRoleAssignments — disabled providers", () => {
  it("never assigns a role to a provider the user disabled", async () => {
    // Both have keys on the keychain; only one is enabled.
    keyed.add("openai");
    keyed.add("zai");
    disabled.add("zai");

    const roles = await resolveRoleAssignments("openai/premium-a");

    expect(roles.size).toBeGreaterThan(0);
    for (const [slot, a] of roles) {
      expect(a.provider, `slot ${slot} was assigned a disabled provider`).not.toBe("zai");
      expect(a.modelId.startsWith("zai/"), `slot ${slot} model ${a.modelId}`).toBe(false);
    }
  });

  it("still assigns from an enabled provider that has a key (no over-filtering)", async () => {
    keyed.add("openai");

    const roles = await resolveRoleAssignments("openai/premium-a");

    expect(roles.get("Architect")?.provider).toBe("openai");
  });

  it("returns an empty map when every keyed provider is disabled", async () => {
    keyed.add("zai");
    keyed.add("opencode-go");
    disabled.add("zai");
    disabled.add("opencode-go");

    const roles = await resolveRoleAssignments("zai/premium-a");

    // No inventory → no assignments. done-gate's R5 short-circuit handles the
    // empty map; what must NEVER happen is a slot pointing at a disabled model.
    expect(roles.size).toBe(0);
  });
});
