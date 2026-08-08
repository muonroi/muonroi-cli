/**
 * `providers.<id>.baseURL` (a third-party gateway / proxy) must reach EVERY
 * factory construction, not just the OAuth branch of createProviderFactoryAsync.
 *
 * Evidence for the regression these lock down: a user proxying anthropic through
 * a third-party relay set `providers.anthropic.baseURL` and still got
 * "invalid x-api-key" — anthropic has no OAuth config, so the override was never
 * read, and council sub-calls (`createProviderFactory(id, {apiKey})`, no baseURL
 * at all) bypassed it on every provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadUserSettings = vi.hoisted(() => vi.fn());
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings,
  getReasoningEffortForModel: () => undefined,
}));

const createFactory = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("../strategies/registry.js", () => ({
  getProviderStrategy: () => ({ id: "anthropic", createFactory }),
}));

import { apiBaseFor } from "../endpoints.js";
import { createProviderFactory } from "../runtime.js";

const GATEWAY = "https://gateway.example.com/v1";

function baseURLPassedToStrategy(): string | undefined {
  return createFactory.mock.calls.at(-1)?.[0]?.baseURL;
}

describe("createProviderFactory — user baseURL override", () => {
  beforeEach(() => {
    createFactory.mockClear();
    loadUserSettings.mockReturnValue({ providers: { anthropic: { baseURL: GATEWAY } } });
  });

  it("applies the override when the caller passes no baseURL (the council sub-call shape)", () => {
    createProviderFactory("anthropic", { apiKey: "sk-test" });
    expect(baseURLPassedToStrategy()).toBe(GATEWAY);
  });

  it("applies the override over a caller-passed DEFAULT apiBase (derived startup state)", () => {
    createProviderFactory("anthropic", { apiKey: "sk-test", baseURL: apiBaseFor("anthropic") });
    expect(baseURLPassedToStrategy()).toBe(GATEWAY);
  });

  it("yields to an explicit non-default caller baseURL (--base-url / OAuth backend)", () => {
    const explicit = "https://per-run.example.com/v1";
    createProviderFactory("anthropic", { apiKey: "sk-test", baseURL: explicit });
    expect(baseURLPassedToStrategy()).toBe(explicit);
  });

  it("leaves baseURL undefined when neither settings nor caller supply one", () => {
    loadUserSettings.mockReturnValue({});
    createProviderFactory("anthropic", { apiKey: "sk-test" });
    expect(baseURLPassedToStrategy()).toBeUndefined();
  });

  it("survives an unreadable settings file (fail-open to the caller value)", () => {
    loadUserSettings.mockImplementation(() => undefined);
    createProviderFactory("anthropic", { apiKey: "sk-test", baseURL: apiBaseFor("anthropic") });
    expect(baseURLPassedToStrategy()).toBe(apiBaseFor("anthropic"));
  });
});
