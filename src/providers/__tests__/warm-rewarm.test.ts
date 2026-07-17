import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import {
  __resetProviderFactoryRegistry,
  createProviderFactory,
  factoryForModel,
  hasProviderFactory,
} from "../runtime.js";
import { rewarmProviderFactory, warmProviderFactories } from "../warm.js";

// Fake fixture value — kept out of inline objects so the repo-wide secret
// scanner does not trip on `apiKey: "..."` literals.
const MOCK_KEY = "x".repeat(32);

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  __resetProviderFactoryRegistry();
});

describe("rewarmProviderFactory", () => {
  // The bug: a provider's factory bakes in the auth it saw when it was built.
  // Boot builds one for openai/xai even with no tokens (getOAuthProviderConfig
  // only reports OAuth SUPPORT), so signing in later left the stale, keyless
  // factory registered and the provider unusable until the next process start.
  test("REPLACES an already-registered factory instead of skipping it", async () => {
    const stale = createProviderFactory("deepseek", { apiKey: MOCK_KEY }).factory;
    expect(factoryForModel("deepseek-v4-flash")).toBe(stale);

    await rewarmProviderFactory("deepseek");

    expect(hasProviderFactory("deepseek")).toBe(true);
    expect(factoryForModel("deepseek-v4-flash")).not.toBe(stale);
  });

  // Contrast: this is exactly what warmProviderFactories does NOT do, which is
  // why it cannot be reused for a credential change.
  test("warmProviderFactories leaves an existing factory alone", async () => {
    const existing = createProviderFactory("deepseek", { apiKey: MOCK_KEY }).factory;

    const result = await warmProviderFactories();

    expect(result.skipped).toContainEqual({ id: "deepseek", reason: "already built" });
    expect(factoryForModel("deepseek-v4-flash")).toBe(existing);
  });

  // Never let a credential-change path throw into the UI: the key is already
  // stored by then, so a rebuild failure must degrade, not explode.
  test("reports failure instead of throwing when the provider cannot be built", async () => {
    await expect(rewarmProviderFactory("definitely-not-a-provider" as never)).resolves.toBe(false);
  });
});
