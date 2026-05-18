/**
 * Tests for src/providers/auth/openai-oauth.ts
 *
 * Authorization Code + PKCE loopback flow. All HTTP + browser + callback
 * server are mocked.
 */

import { describe, expect, it, vi } from "vitest";
import type { OAuthCallbackServer } from "../../../mcp/oauth-callback.js";
import type { FetchFn } from "../device-flow.js";
import type { CallbackServerFn, OpenBrowserFn } from "../openai-oauth.js";
import { OpenAIOAuthProvider } from "../openai-oauth.js";
import type { OAuthTokens } from "../types.js";
import { OAuthLoginError, OAuthRefreshError } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function makeMockFetch(responses: Array<MockResponse | (() => MockResponse)>) {
  let idx = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const resp = responses[idx++];
    const r = typeof resp === "function" ? resp() : resp;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: r.json ?? (() => Promise.resolve({})),
      text: r.text ?? (() => Promise.resolve("")),
    };
  });
}

/**
 * Returns a CallbackServerFn that simulates a browser hitting the callback
 * URL with `?code=<authCode>&state=<state>` shortly after the server binds.
 * The state echoed back is read from the authorize URL passed to onUserCode
 * via a captured side-channel.
 */
function makeMockCallbackServer(authCode: string, echoState: () => string): CallbackServerFn {
  return vi.fn(async (opts) => {
    const port = opts.port ?? 1455;
    const path = opts.path ?? "/auth/callback";
    const url = `http://localhost:${port}${path}`;
    // Fire the callback asynchronously to simulate the browser round-trip.
    setTimeout(() => opts.onCode(authCode, echoState()), 1);
    const server: OAuthCallbackServer = {
      port,
      url,
      close: vi.fn(),
    };
    return server;
  }) as unknown as CallbackServerFn;
}

// ---------------------------------------------------------------------------
// Happy-path login
// ---------------------------------------------------------------------------

describe("OpenAIOAuthProvider.login", () => {
  it("runs Authorization Code + PKCE loopback flow and returns tokens with email", async () => {
    const mockFetch = makeMockFetch([
      // token exchange
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "acc-tok-fixture",
            refresh_token: "refresh_abc",
            id_token: "mock-id-token",
            expires_in: 3600,
            account_id: "acc_789",
          }),
      },
      // userinfo
      { ok: true, json: () => Promise.resolve({ email: "user@example.com", name: "Test User" }) },
    ]);

    let capturedAuthorizeUrl = "";
    const openBrowser: OpenBrowserFn = vi.fn((url: string) => {
      capturedAuthorizeUrl = url;
    });

    const callbackServer = makeMockCallbackServer("auth_code_xyz", () => {
      const u = new URL(capturedAuthorizeUrl);
      return u.searchParams.get("state") ?? "";
    });

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    const userCodeCb = vi.fn();
    const tokens = await provider.login({ onUserCode: userCodeCb });

    // onUserCode receives the authorize URL (both args identical).
    expect(userCodeCb).toHaveBeenCalled();
    const [arg0, arg1] = userCodeCb.mock.calls[0] as [string, string];
    expect(arg0).toBe(arg1);
    expect(arg0).toContain("https://auth.openai.com/oauth/authorize");
    expect(arg0).toContain("response_type=code");
    expect(arg0).toContain("code_challenge_method=S256");
    expect(arg0).toContain("codex_cli_simplified_flow=true");
    expect(arg0).toContain("originator=codex_cli_rs");
    expect(arg0).toContain("api.connectors.read");
    expect(arg0).not.toContain("access_type=offline");
    expect(arg0).not.toContain("prompt=consent");
    expect(arg0).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");

    expect(openBrowser).toHaveBeenCalled();

    expect(tokens.accessToken).toBe("acc-tok-fixture");
    expect(tokens.refreshToken).toBe("refresh_abc");
    expect(tokens.accountId).toBe("acc_789");
    expect(tokens.email).toBe("user@example.com");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    // Token exchange POST body should carry the auth code + code_verifier.
    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(tokenInit.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth_code_xyz");
    expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(body.get("code_verifier")).toBeTruthy();
  });

  it("throws OAuthLoginError when token exchange fails", async () => {
    const mockFetch = makeMockFetch([{ ok: false, status: 400, text: () => Promise.resolve("invalid_grant") }]);

    let capturedAuthorizeUrl = "";
    const openBrowser: OpenBrowserFn = vi.fn((url: string) => {
      capturedAuthorizeUrl = url;
    });
    const callbackServer = makeMockCallbackServer("bad_code", () => {
      const u = new URL(capturedAuthorizeUrl);
      return u.searchParams.get("state") ?? "";
    });

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });

  it("throws on state mismatch (CSRF guard)", async () => {
    const mockFetch = makeMockFetch([]);
    const openBrowser: OpenBrowserFn = vi.fn();
    // Callback returns a state that does NOT match the one in the authorize URL.
    const callbackServer = makeMockCallbackServer("auth_code_xyz", () => "attacker_state");

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });

  it("falls back to port 1457 when 1455 is occupied", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () => Promise.resolve({ access_token: "acc", refresh_token: "r", expires_in: 3600 }),
      },
      { ok: true, json: () => Promise.resolve({ email: "u@example.com" }) },
    ]);

    let capturedAuthorizeUrl = "";
    let attempt = 0;
    const callbackServer = vi.fn(async (opts: Parameters<CallbackServerFn>[0]) => {
      attempt++;
      if (attempt === 1) {
        throw new Error("EADDRINUSE");
      }
      const port = opts.port ?? 1457;
      const url = `http://localhost:${port}${opts.path}`;
      setTimeout(() => {
        const u = new URL(capturedAuthorizeUrl);
        opts.onCode("auth_code", u.searchParams.get("state") ?? "");
      }, 1);
      return { port, url, close: vi.fn() } satisfies OAuthCallbackServer;
    }) as unknown as CallbackServerFn;

    const openBrowser: OpenBrowserFn = vi.fn((url: string) => {
      capturedAuthorizeUrl = url;
    });

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    const tokens = await provider.login({});
    expect(tokens.accessToken).toBe("acc");
    expect(attempt).toBe(2);
    expect(capturedAuthorizeUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1457%2Fauth%2Fcallback");
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("OpenAIOAuthProvider.refresh", () => {
  const expiredTokens: OAuthTokens = {
    accessToken: "old-acc-tok",
    refreshToken: "old-ref-tok",
    expiresAt: Date.now() - 1,
    accountId: "acc_789",
    email: "user@example.com",
  };

  it("exchanges refresh token for new tokens", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-acc-tok",
            refresh_token: "new-ref-tok",
            expires_in: 3600,
          }),
      },
    ]);

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    const refreshed = await provider.refresh(expiredTokens);

    expect(refreshed.accessToken).toBe("new-acc-tok");
    expect(refreshed.refreshToken).toBe("new-ref-tok");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    expect(refreshed.email).toBe("user@example.com");
    expect(refreshed.accountId).toBe("acc_789");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-ref-tok");
  });

  it("throws OAuthRefreshError on 401 (invalid_grant)", async () => {
    const mockFetch = makeMockFetch([{ ok: false, status: 401, text: () => Promise.resolve("invalid_grant") }]);

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    await expect(provider.refresh(expiredTokens)).rejects.toThrow(OAuthRefreshError);
  });

  it("returns tokens unchanged when still valid (not within refresh window)", async () => {
    const validTokens: OAuthTokens = {
      accessToken: "valid-acc-tok",
      refreshToken: "valid-ref-tok",
      expiresAt: Date.now() + 10 * 60_000,
    };

    const mockFetch = vi.fn();
    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    const result = await provider.refresh(validTokens);
    expect(result).toBe(validTokens);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("OpenAIOAuthProvider.revoke", () => {
  it("POSTs to /oauth/revoke with the refresh token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    const tokens: OAuthTokens = {
      accessToken: "acc",
      refreshToken: "ref.token.long",
      expiresAt: Date.now() + 3600_000,
    };

    await provider.revoke(tokens);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://auth.openai.com/oauth/revoke");
  });

  it("does not throw when revoke call fails (best-effort)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));

    const provider = new OpenAIOAuthProvider({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    const tokens: OAuthTokens = {
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: Date.now(),
    };

    await expect(provider.revoke(tokens)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// authHeaders
// ---------------------------------------------------------------------------

describe("OpenAIOAuthProvider.authHeaders", () => {
  it("returns Authorization + ChatGPT-Account-ID when accountId present", () => {
    const provider = new OpenAIOAuthProvider();
    const tokens: OAuthTokens = {
      accessToken: "mock-token",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
      accountId: "acc_123",
    };

    const headers = provider.authHeaders(tokens);
    expect(headers.Authorization).toBe("Bearer mock-token");
    expect(headers["ChatGPT-Account-ID"]).toBe("acc_123");
  });

  it("omits ChatGPT-Account-ID when accountId absent", () => {
    const provider = new OpenAIOAuthProvider();
    const tokens: OAuthTokens = {
      accessToken: "mock-token",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
    };

    const headers = provider.authHeaders(tokens);
    expect(headers.Authorization).toBe("Bearer mock-token");
    expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
  });
});
