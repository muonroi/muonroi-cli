/**
 * Tests for src/providers/auth/grok-oauth.ts
 *
 * xAI / Grok subscription OAuth — Authorization Code + PKCE loopback flow
 * (SuperGrok / X Premium+). All HTTP + browser + callback server are mocked,
 * so the nondeterministic live login is not needed to verify the flow logic.
 */

import { describe, expect, it, vi } from "vitest";
import type { OAuthCallbackServer } from "../../../mcp/oauth-callback.js";
import type { FetchFn } from "../device-flow.js";
import type { CallbackServerFn, OpenBrowserFn } from "../grok-oauth.js";
import { GrokOAuthProvider } from "../grok-oauth.js";
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
 * Returns a CallbackServerFn that simulates the browser hitting the loopback
 * callback with `?code=<authCode>&state=<state>` shortly after the server binds.
 * The echoed state is read back from the authorize URL via a captured closure.
 */
function makeMockCallbackServer(authCode: string, echoState: () => string): CallbackServerFn {
  return vi.fn(async (opts) => {
    const port = 56121;
    const url = `http://127.0.0.1:${port}/callback`;
    setTimeout(() => opts.onCode(authCode, echoState()), 1);
    const server: OAuthCallbackServer = { port, url, close: vi.fn() };
    return server;
  }) as unknown as CallbackServerFn;
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe("GrokOAuthProvider.login", () => {
  it("runs Authorization Code + PKCE loopback flow and returns tokens with email", async () => {
    // id_token carries the email claim (base64url JSON middle segment).
    const idTokenPayload = Buffer.from(JSON.stringify({ email: "grok@example.com" })).toString("base64url");
    const idToken = `h.${idTokenPayload}.s`;

    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "xai-acc-tok",
            refresh_token: "xai-refresh",
            id_token: idToken,
            expires_in: 3600,
          }),
      },
    ]);

    let capturedAuthorizeUrl = "";
    const openBrowser: OpenBrowserFn = vi.fn((url: string) => {
      capturedAuthorizeUrl = url;
    });
    const callbackServer = makeMockCallbackServer("xai_auth_code", () => {
      const u = new URL(capturedAuthorizeUrl);
      return u.searchParams.get("state") ?? "";
    });

    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    const userCodeCb = vi.fn();
    const tokens = await provider.login({ onUserCode: userCodeCb });

    expect(userCodeCb).toHaveBeenCalled();
    expect(capturedAuthorizeUrl).toContain("https://auth.x.ai/oauth2/authorize");
    expect(capturedAuthorizeUrl).toContain("response_type=code");
    expect(capturedAuthorizeUrl).toContain("code_challenge_method=S256");
    expect(capturedAuthorizeUrl).toContain("client_id=test_xai_client");
    // xAI-specific scopes + extras
    expect(decodeURIComponent(capturedAuthorizeUrl)).toContain("grok-cli:access");
    expect(decodeURIComponent(capturedAuthorizeUrl)).toContain("offline_access");
    expect(capturedAuthorizeUrl).toContain("plan=generic");
    expect(capturedAuthorizeUrl).toContain("nonce=");
    // Google-only params must NOT leak in (xAI rejects them).
    expect(capturedAuthorizeUrl).not.toContain("access_type=offline");
    expect(capturedAuthorizeUrl).not.toContain("prompt=consent");

    expect(openBrowser).toHaveBeenCalled();

    expect(tokens.accessToken).toBe("xai-acc-tok");
    expect(tokens.refreshToken).toBe("xai-refresh");
    expect(tokens.email).toBe("grok@example.com");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    // Token exchange POST body carries auth code + code_verifier.
    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://auth.x.ai/oauth2/token");
    const body = new URLSearchParams(tokenInit.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("xai_auth_code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
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

    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });

  it("throws on state mismatch (CSRF guard)", async () => {
    const mockFetch = makeMockFetch([]);
    const openBrowser: OpenBrowserFn = vi.fn();
    const callbackServer = makeMockCallbackServer("xai_auth_code", () => "attacker_state");

    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: callbackServer,
      openBrowserFn: openBrowser,
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("GrokOAuthProvider.refresh", () => {
  const expiredTokens: OAuthTokens = {
    accessToken: "old-acc",
    refreshToken: "old-ref",
    expiresAt: Date.now() - 1,
    email: "grok@example.com",
  };

  it("exchanges refresh token for new tokens", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () => Promise.resolve({ access_token: "new-acc", refresh_token: "new-ref", expires_in: 3600 }),
      },
    ]);

    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    const refreshed = await provider.refresh(expiredTokens);
    expect(refreshed.accessToken).toBe("new-acc");
    expect(refreshed.refreshToken).toBe("new-ref");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    expect(refreshed.email).toBe("grok@example.com");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-ref");
  });

  it("keeps the old refresh token when the response omits a new one (non-rotating)", async () => {
    const mockFetch = makeMockFetch([
      { ok: true, json: () => Promise.resolve({ access_token: "new-acc", expires_in: 3600 }) },
    ]);
    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });
    const refreshed = await provider.refresh(expiredTokens);
    expect(refreshed.refreshToken).toBe("old-ref");
  });

  it("throws OAuthRefreshError on 401 (invalid_grant)", async () => {
    const mockFetch = makeMockFetch([{ ok: false, status: 401, text: () => Promise.resolve("invalid_grant") }]);
    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });
    await expect(provider.refresh(expiredTokens)).rejects.toThrow(OAuthRefreshError);
  });

  it("returns tokens unchanged when still valid (not within refresh window)", async () => {
    const validTokens: OAuthTokens = {
      accessToken: "valid-acc",
      refreshToken: "valid-ref",
      expiresAt: Date.now() + 10 * 60_000,
    };
    const mockFetch = vi.fn();
    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
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

describe("GrokOAuthProvider.revoke", () => {
  it("does not throw when revoke call fails (best-effort)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const provider = new GrokOAuthProvider({
      issuer: "https://auth.x.ai",
      clientId: "test_xai_client",
      fetchFn: mockFetch as unknown as FetchFn,
    });
    const tokens: OAuthTokens = { accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() };
    await expect(provider.revoke(tokens)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// authHeaders
// ---------------------------------------------------------------------------

describe("GrokOAuthProvider.authHeaders", () => {
  it("returns only a Bearer Authorization header (no account-id header)", () => {
    const provider = new GrokOAuthProvider();
    const tokens: OAuthTokens = {
      accessToken: "mock-token",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
    };
    const headers = provider.authHeaders(tokens);
    expect(headers.Authorization).toBe("Bearer mock-token");
    expect(Object.keys(headers)).toEqual(["Authorization"]);
  });
});
