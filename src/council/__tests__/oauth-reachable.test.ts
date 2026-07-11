import { beforeAll, describe, expect, it, vi } from "vitest";

// F15 regression: council participant resolution must treat OAuth-authed
// providers (no API key) as reachable. getConfiguredProviders() is the
// authoritative cred check; the old loadKeyForProvider-only path threw for
// OAuth-only providers → 0 participants → council bailed "No reachable
// provider" even though the model (e.g. grok via xAI OAuth) answers fine.

// xai is configured via OAuth only (present in getConfiguredProviders, but
// loadKeyForProvider would have thrown — no API key).
vi.mock("../../providers/keychain.js", () => ({
  getConfiguredProviders: vi.fn(async () => ["xai"]),
}));
// Hermetic settings: no explicit role models, nothing disabled.
vi.mock("../../utils/settings.js", () => ({
  getRoleModels: () => ({}),
  getRoleModel: () => undefined,
  isProviderDisabled: () => false,
}));

import { loadCatalog } from "../../models/registry.js";
import { resolveParticipants } from "../leader.js";

describe("F15 — council reachability counts OAuth-only providers", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("resolves >=2 participants when the session provider is OAuth-only (xai, no API key)", async () => {
    const participants = await resolveParticipants("grok-4.5", false);
    // Pre-fix this returned [] (loadKeyForProvider('xai') threw) → council bailed.
    expect(participants.length).toBeGreaterThanOrEqual(2);
    expect(participants.every((p) => p.model.startsWith("grok"))).toBe(true);
  });
});
