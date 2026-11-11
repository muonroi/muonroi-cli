/**
 * Regression: Agent.setModel / Agent.setApiKey must NOT carry a previous
 * provider's default baseURL into the new provider's factory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { apiBaseFor } from "../../providers/endpoints.js";
import { Agent } from "../orchestrator.js";

describe("Agent provider switch — baseURL hygiene", () => {
  let fixtureHome: string;
  beforeAll(async () => {
    // Exercise root provider switching independently of the developer's own
    // disabled-provider preferences, without weakening production eligibility.
    fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-base-url-"));
    vi.stubEnv("HOME", fixtureHome);
    vi.stubEnv("USERPROFILE", fixtureHome);
    vi.stubEnv("MUONROI_CLI_HOME", path.join(fixtureHome, ".muonroi-cli"));
    await loadCatalog();
  });

  beforeEach(() => {
    vi.stubEnv("MUONROI_TEST_NO_PERSIST", "1");
    vi.stubEnv("MUONROI_TEST_NO_KEYCHAIN", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fixtureHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it("setModel drops a custom baseURL too — a gateway URL belongs to ONE provider", () => {
    // A third-party gateway configured for provider A is not a valid endpoint
    // for provider B. Preserving it (the old behaviour) sent every post-switch
    // request to A's gateway carrying B's key: a user proxying anthropic through
    // api.<gateway>/v1 had their deepseek role-models (leader/implement) POSTed
    // there too. The new provider's URL is re-resolved when its factory is
    // rebuilt — `resolveFactoryBaseURL` reads `providers.<id>.baseURL` and each
    // strategy falls back to its own apiBase — so dropping here loses nothing.
    const customURL = "https://proxy.internal.example.com/v1";
    const agent = new Agent("sk-test", customURL, "deepseek-v4-flash", undefined, {
      persistSession: false,
    });
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBe(customURL);

    agent.setModel("glm-4.7");
    expect((agent as unknown as { baseURL: string | null }).baseURL).toBeNull();
  });

  it("setApiKey preserves a custom baseURL for the CURRENT provider", () => {
    // The drop above is scoped to provider CHANGES. Within one provider a custom
    // gateway must survive, or the anthropic-via-proxy setup would silently
    // revert to api.anthropic.com on the first key (re)binding.
    const customURL = "https://proxy.internal.example.com/v1";
    const agent = new Agent(undefined, undefined, "glm-4.7", undefined, {
      persistSession: false,
    });
    agent.setApiKey("sk-test", customURL);
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
