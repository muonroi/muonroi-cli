import { describe, expect, it } from "vitest";
import { shouldUseRoleModel } from "./decide.js";

/**
 * Regression for the "stale roleModel after provider switch" failure observed
 * live: user switched active provider to openai (gpt-5.4-mini) but their
 * user-settings.roleModels still pointed at deepseek-v4-flash. The council /
 * sprint role phases blindly honored the deepseek roleModel and failed
 * mid-task with 402 Insufficient Balance. A cross-provider role model must only
 * be honored when the user explicitly opted into multi-provider council.
 */
describe("shouldUseRoleModel", () => {
  it("honors a role model whose provider matches the active provider", () => {
    expect(shouldUseRoleModel("openai", "openai", { providerDisabled: false, multiProviderPreferred: false })).toBe(
      true,
    );
  });

  it("SKIPS a cross-provider role model when multi-provider is OFF (stale after switch)", () => {
    // roleModel resolves to deepseek but the user is now on openai, multi off.
    expect(shouldUseRoleModel("deepseek", "openai", { providerDisabled: false, multiProviderPreferred: false })).toBe(
      false,
    );
  });

  it("honors a cross-provider role model when multi-provider is ON (explicit opt-in)", () => {
    expect(shouldUseRoleModel("deepseek", "openai", { providerDisabled: false, multiProviderPreferred: true })).toBe(
      true,
    );
  });

  it("SKIPS when the role model provider is disabled, even if it matches", () => {
    expect(shouldUseRoleModel("anthropic", "anthropic", { providerDisabled: true, multiProviderPreferred: true })).toBe(
      false,
    );
  });
});
