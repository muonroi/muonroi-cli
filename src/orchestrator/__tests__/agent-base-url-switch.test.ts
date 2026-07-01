/**
 * Regression: Agent.setModel / Agent.setApiKey must NOT carry a previous
 * provider's default baseURL into the new provider's factory.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { apiBaseFor } from "../../providers/endpoints.js";
import { Agent } from "../orchestrator.js";

describe("Agent provider switch — baseURL hygiene", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    process.env.MUONROI_TEST_NO_PERSIST = "1";
    process.env.MUONROI_TEST_NO_KEYCHAIN = "1";
  });

  afterEach(() => {
    delete process.env.MUONROI_TEST_NO_PERSIST;
    delete process.env.MUONROI_TEST_NO_KEYCHAIN;
  });

  it("setModel drops stale baseURL when switching to a different provider", () => {
    const agent = new Agent("sk-test-deepseek", apiBaseFor("deepseek"), "deepseek-v4-flash", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("deepseek");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(apiBaseFor("deepseek"));

    agent.setModel("glm-4.7");
    expect(agent.getProviderId()).toBe("zai");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBeNull();
  });

  it("setModel preserves a genuine custom baseURL (not a known provider apiBase)", () => {
    const customURL = "https://proxy.internal.example.com/v1";
    const agent = new Agent("sk-test", customURL, "deepseek-v4-flash", undefined, {
      persistSession: false,
    });
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(customURL);

    agent.setModel("glm-4.7");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(customURL);
  });

  it("setModel does NOT drop baseURL when staying on the same provider", () => {
    const agent = new Agent("sk-test", apiBaseFor("zai"), "glm-4.7", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("zai");

    agent.setModel("glm-5.2");
    expect(agent.getProviderId()).toBe("zai");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(apiBaseFor("zai"));
  });

  it("setApiKey drops a stale apiBase that targets a different provider", () => {
    const agent = new Agent(undefined, undefined, "glm-4.7", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("zai");

    agent.setApiKey("sk-test", apiBaseFor("deepseek"));
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBeNull();
  });
});
