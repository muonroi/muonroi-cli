/**
 * Regression: Agent.setModel / Agent.setApiKey must NOT carry a previous
 * provider's default baseURL into the new provider's factory.
 *
 * Evidence (session 2492d6579b1d, see DB `interaction_logs.error api` row
 * with metadata 'The supported API model names are deepseek-v4-pro or
 * deepseek-v4-flash, but you passed deepseek-ai/DeepSeek-V4-Flash.'):
 *
 * Before the fix, switching defaultProvider from deepseek → siliconflow via
 * the UI left this.baseURL = "https://api.deepseek.com" from startup. The
 * setModel rebuild path constructed a SiliconflowStrategy factory but bound
 * it to the DeepSeek apiBase, so requests landed at api.deepseek.com with a
 * SiliconFlow-prefixed model id, which DeepSeek rejected with the literal
 * error string above.
 *
 * This test exercises the public Agent surface to confirm the fix detects a
 * stale "this is another provider's default apiBase" baseURL and drops it.
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
    // Tests run in-process with no real key persistence; skip session DB to
    // keep the assertions on pure provider/URL state.
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

    agent.setModel("deepseek-ai/DeepSeek-V4-Flash");
    expect(agent.getProviderId()).toBe("siliconflow");
    // Stale DS apiBase must be dropped so the SF factory binds to SF's URL.
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBeNull();
  });

  it("setModel preserves a genuine custom baseURL (not a known provider apiBase)", () => {
    const customURL = "https://proxy.internal.example.com/v1";
    const agent = new Agent("sk-test", customURL, "deepseek-v4-flash", undefined, {
      persistSession: false,
    });
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(customURL);

    agent.setModel("deepseek-ai/DeepSeek-V4-Flash");
    // Custom URL doesn't match any known provider apiBase → kept as override.
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(customURL);
  });

  it("setModel does NOT drop baseURL when staying on the same provider", () => {
    const agent = new Agent("sk-test", apiBaseFor("siliconflow"), "alibaba/Qwen3-30B-A3B-Instruct-2507", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("siliconflow");

    agent.setModel("deepseek-ai/DeepSeek-V4-Flash");
    expect(agent.getProviderId()).toBe("siliconflow");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(apiBaseFor("siliconflow"));
  });

  it("setApiKey drops a stale apiBase that targets a different provider", () => {
    const agent = new Agent(undefined, undefined, "deepseek-ai/DeepSeek-V4-Flash", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("siliconflow");

    // Caller hands setApiKey a stale DeepSeek apiBase — must be dropped.
    agent.setApiKey("sk-test", apiBaseFor("deepseek"));
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBeNull();
  });
});
