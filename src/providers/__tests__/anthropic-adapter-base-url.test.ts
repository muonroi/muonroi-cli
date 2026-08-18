/**
 * `createAnthropicAdapter` must thread `config.baseURL` into the SDK client,
 * like every other adapter (openai.ts, openai-compatible.ts).
 *
 * It used to drop it, so the legacy Adapter path always hit api.anthropic.com:
 * a caller running anthropic through a third-party gateway had the gateway's
 * key rejected by the real API as "invalid x-api-key".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed arg: an untyped `vi.fn(() => …)` infers a 0-tuple for `mock.calls`, so
// indexing [0] is a tsc error even though the mock records the argument.
const createAnthropic = vi.hoisted(() => vi.fn((_opts: Record<string, unknown>) => vi.fn()));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

import { createAnthropicAdapter } from "../anthropic.js";

const GATEWAY = "https://gateway.example.com/v1";
const FAKE_KEY = ["anthropic", "fixture", "key", "for", "unit", "tests"].join("-");

function clientConfig(): Record<string, unknown> {
  return createAnthropic.mock.calls.at(-1)?.[0] ?? {};
}

describe("createAnthropicAdapter — baseURL threading", () => {
  beforeEach(() => createAnthropic.mockClear());

  it("passes a custom baseURL on the API-key path", () => {
    createAnthropicAdapter({ apiKey: FAKE_KEY, baseURL: GATEWAY, model: "claude-sonnet-5" });
    expect(clientConfig().baseURL).toBe(GATEWAY);
    expect(clientConfig().apiKey).toBe(FAKE_KEY);
  });

  it("passes a custom baseURL on the OAuth path (auth still via headers)", () => {
    const headers = { Authorization: "Bearer FAKE_oauth_access_token" };
    createAnthropicAdapter({ oauthHeaders: headers, baseURL: GATEWAY, model: "claude-sonnet-5" });
    expect(clientConfig().baseURL).toBe(GATEWAY);
    expect(clientConfig().headers).toBe(headers);
    // Placeholder key — the Authorization header is the real credential.
    expect(clientConfig().apiKey).toBe("oauth");
  });

  it("leaves baseURL undefined when the caller supplies none (SDK default applies)", () => {
    createAnthropicAdapter({ apiKey: FAKE_KEY, model: "claude-sonnet-5" });
    expect(clientConfig().baseURL).toBeUndefined();
  });
});
