import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../models/registry.js";
import * as runtime from "../../providers/runtime.js";
import type { ModelInfo } from "../../types/index.js";
import * as settings from "../../utils/settings.js";
import { resolveLeaderModel } from "../leader.js";

/**
 * Regression: which model leads a council must not be decided by catalog line
 * order.
 *
 * `resolveLeaderModel` used `getModelsForProvider(p).find(m => m.roles?.includes("leader"))`
 * and returned the FIRST tagged model, skipping the tier ranking below it. That
 * holds while exactly one model carries the tag. Measured 2026-09-09 against the
 * real catalog.json it does not: stepfun tags all three of step-3.5-flash,
 * step-3.5-flash-2603 and step-3.7-flash as leader, so a live session
 * (98c8293f6d04) ran with leader step-3.5-flash — balanced tier — while the
 * premium step-3.7-flash sat unused on the same provider. zai has the identical
 * shape (glm-4.7 over glm-5.2).
 *
 * The fixture below reproduces exactly that ordering: the premium model is listed
 * LAST, so a catalog-order pick returns the balanced one.
 */

// Deliberately ordered balanced-first, premium-last — the shape that broke.
const catalog: ModelInfo[] = [
  { id: "vendor-mid", provider: "stepfun", tier: "balanced", roles: ["leader", "verify"] } as ModelInfo,
  { id: "vendor-mid-dated", provider: "stepfun", tier: "balanced", roles: ["leader"] } as ModelInfo,
  { id: "vendor-top", provider: "stepfun", tier: "premium", roles: ["leader"] } as ModelInfo,
  // A provider whose only leader-tagged model is not its highest tier: the tag
  // is an explicit signal and must still win over an untagged premium model.
  { id: "other-top-untagged", provider: "openai", tier: "premium" } as ModelInfo,
  { id: "other-tagged", provider: "openai", tier: "balanced", roles: ["leader"] } as ModelInfo,
];

describe("resolveLeaderModel — catalog leader pick is tier-ranked, not order-ranked", () => {
  beforeEach(() => {
    // pickCatalogLeader reads the TEXT view of the provider's catalog, so a
    // non-text row (audio/image) can never be seated as leader. Every fixture
    // below is a plain text model, so the two views are identical here and this
    // test's subject — tier ranking vs catalog order — is unaffected.
    const forProvider = (p: string) => catalog.filter((m) => m.provider === p) as ModelInfo[];
    vi.spyOn(registry, "getModelsForProvider").mockImplementation((p) => forProvider(p));
    vi.spyOn(registry, "getTextModelsForProvider").mockImplementation((p) => forProvider(p));
    vi.spyOn(runtime, "detectProviderForModel").mockImplementation((id) => {
      const m = catalog.find((x) => x.id === id);
      return (m?.provider ?? "stepfun") as ReturnType<typeof runtime.detectProviderForModel>;
    });
    // No user-configured leader — this test is about the catalog path.
    vi.spyOn(settings, "getRoleModel").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the highest-tier leader-tagged model even when it is listed last", () => {
    expect(resolveLeaderModel("vendor-mid-dated")).toBe("vendor-top");
  });

  it("does not depend on which model started the session", () => {
    expect(resolveLeaderModel("vendor-mid")).toBe("vendor-top");
    expect(resolveLeaderModel("vendor-top")).toBe("vendor-top");
  });

  it("still honours the leader tag over an untagged higher tier", () => {
    // The tag is the explicit signal; an untagged premium model must not steal
    // the role just for being premium.
    expect(resolveLeaderModel("other-tagged")).toBe("other-tagged");
  });

  it("a user-configured leader still wins outright", () => {
    vi.spyOn(settings, "getRoleModel").mockReturnValue("vendor-mid");
    expect(resolveLeaderModel("vendor-top")).toBe("vendor-mid");
  });
});
