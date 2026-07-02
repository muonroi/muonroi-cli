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

  it("setModel does NOT carry the 'oauth' sentinel to a different (API-key) provider", () => {
    // OAuth session (apiKey == "oauth") on an OAuth-backed provider, switching
    // to native deepseek. The literal "oauth" must NOT reach the deepseek
    // factory (it would be sent as the API key → api.deepseek.com 401
    // "your api key ****auth is invalid", evidence: session ff932f8568e8).
    // Instead the provider is dropped and _initOAuthProvider is re-armed so the
    // next turn resolves deepseek's own key.
    const agent = new Agent("oauth", undefined, "opencode/deepseek-v4-flash", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("opencode-go");

    agent.setModel("deepseek-v4-flash");
    expect(agent.getProviderId()).toBe("deepseek");
    // Provider deferred (not built with the leaked sentinel) …
    expect((agent as unknown as { provider: unknown }).provider).toBeNull();
    // … and the one-shot OAuth init re-armed so the next turn re-resolves auth.
    expect((agent as unknown as { _oauthInitDone: boolean })._oauthInitDone).toBe(false);
  });

  it("setModel defers construction on ANY provider switch — does not reuse the previous provider's key", () => {
    // The core cross-provider-key bug: switching providers in the TUI called
    // agent.setModel(newModel), which rebuilt the new provider's factory with
    // the PREVIOUS provider's key → 401 "invalid api key" on every switch
    // (evidence: routing log "routed to deepseek-v4-flash via deepseek" with a
    // non-deepseek key). A real key must NOT be carried across providers: the
    // switch defers so _initOAuthProvider re-resolves the NEW provider's own key.
    const agent = new Agent("sk-real-zai-key-1234567890", undefined, "glm-4.7", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("zai");
    expect(agent.hasApiKey()).toBe(true);

    agent.setModel("deepseek-v4-flash");
    expect(agent.getProviderId()).toBe("deepseek");
    // Provider deferred; the stale zai key was cleared (not reused for deepseek).
    expect((agent as unknown as { provider: unknown }).provider).toBeNull();
    expect((agent as unknown as { apiKey: string | null }).apiKey).toBeNull();
    expect((agent as unknown as { _oauthInitDone: boolean })._oauthInitDone).toBe(false);
  });

  it("setModel does NOT defer when staying on the same provider (key preserved)", () => {
    // Same-provider model swaps must keep the live provider + key intact — the
    // deferral only triggers when the provider actually changes.
    const agent = new Agent("sk-real-zai-key-1234567890", undefined, "glm-4.7", undefined, {
      persistSession: false,
    });
    expect(agent.getProviderId()).toBe("zai");

    agent.setModel("glm-5.2");
    expect(agent.getProviderId()).toBe("zai");
    expect((agent as unknown as { provider: unknown }).provider).not.toBeNull();
    expect((agent as unknown as { apiKey: string | null }).apiKey).toBe("sk-real-zai-key-1234567890");
  });
});
