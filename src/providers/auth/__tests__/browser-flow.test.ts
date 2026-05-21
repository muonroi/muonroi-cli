/**
 * Tests for src/providers/auth/browser-flow.ts
 *
 * buildAuthorizeUrl structure, PKCE roundtrip,
 * exchangeBrowserCode and refreshBrowserTokens mock HTTP.
 * No live network calls.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, exchangeBrowserCode, generatePKCE, refreshBrowserTokens } from "../browser-flow.js";
import type { FetchFn } from "../device-flow.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

interface MockResponse {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function makeMockFetch(responses: MockResponse[]) {
  let idx = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[idx++] ?? { ok: false, status: 500 };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: r.json ?? (() => Promise.resolve({})),
      text: r.text ?? (() => Promise.resolve("")),
    };
  });
}

// ---------------------------------------------------------------------------
// generatePKCE (re-exported from device-flow)
// ---------------------------------------------------------------------------

describe("generatePKCE (re-export)", () => {
  it("returns verifier and challenge with correct lengths", () => {
    const { codeVerifier, codeChallenge } = generatePKCE();
    // base64url(32 bytes) = 43 chars
    expect(codeVerifier).toHaveLength(43);
    // sha256(verifier) base64url = 43 chars
    expect(codeChallenge).toHaveLength(43);
  });

  it("challenge is S256 of verifier", () => {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    expect(codeChallenge).toBe(expected);
  });

  it("each call produces unique verifier", () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  it("constructs URL with required OAuth 2.0 params", () => {
    const url = buildAuthorizeUrl({
      authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "test-client-id",
      redirectUri: "http://127.0.0.1:9999/callback",
      scopes: ["openid", "email"],
      codeChallenge: "test-challenge-abc",
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9999/callback");
    expect(parsed.searchParams.get("scope")).toBe("openid email");
    expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
  });

  it("includes state param when provided", () => {
    const url = buildAuthorizeUrl({
      authEndpoint: "https://example.com/auth",
      clientId: "cid",
      redirectUri: "http://localhost/cb",
      scopes: ["openid"],
      codeChallenge: "chall",
      state: "random-state-xyz",
    });

    expect(new URL(url).searchParams.get("state")).toBe("random-state-xyz");
  });

  it("omits state param when not provided", () => {
    const url = buildAuthorizeUrl({
      authEndpoint: "https://example.com/auth",
      clientId: "cid",
      redirectUri: "http://localhost/cb",
      scopes: ["openid"],
      codeChallenge: "chall",
    });

    expect(new URL(url).searchParams.has("state")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exchangeBrowserCode
// ---------------------------------------------------------------------------

describe("exchangeBrowserCode", () => {
  it("returns token response on success", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fixture-access-tok",
            refresh_token: "fixture-refresh-tok",
            id_token: "fixture-id-tok",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      },
    ]);

    const result = await exchangeBrowserCode({
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://127.0.0.1:9999/callback",
      code: "auth-code-123",
      codeVerifier: "verifier-xyz",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    expect(result.access_token).toBe("fixture-access-tok");
    expect(result.refresh_token).toBe("fixture-refresh-tok");
    expect(result.expires_in).toBe(3600);

    // Verify the fetch was called with correct args
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-123");
    expect(body.get("code_verifier")).toBe("verifier-xyz");
    expect(body.get("client_id")).toBe("test-client");
    expect(body.get("client_secret")).toBe("test-secret");
  });

  it("throws on HTTP error response", async () => {
    const mockFetch = makeMockFetch([
      { ok: false, status: 400, text: () => Promise.resolve('{"error":"invalid_grant"}') },
    ]);

    await expect(
      exchangeBrowserCode({
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        clientSecret: "sec",
        redirectUri: "http://localhost/cb",
        code: "bad-code",
        codeVerifier: "verifier",
        fetchFn: mockFetch as unknown as FetchFn,
      }),
    ).rejects.toThrow("Token exchange failed (400)");
  });
});

// ---------------------------------------------------------------------------
// refreshBrowserTokens
// ---------------------------------------------------------------------------

describe("refreshBrowserTokens", () => {
  it("returns new tokens on success", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-tok",
            expires_in: 3600,
          }),
      },
    ]);

    const result = await refreshBrowserTokens({
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "old-refresh",
      fetchFn: mockFetch as unknown as FetchFn,
    });

    expect(result.access_token).toBe("new-access-tok");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  it("throws on HTTP 401", async () => {
    const mockFetch = makeMockFetch([
      { ok: false, status: 401, text: () => Promise.resolve('{"error":"invalid_grant"}') },
    ]);

    await expect(
      refreshBrowserTokens({
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        clientSecret: "sec",
        refreshToken: "expired-refresh",
        fetchFn: mockFetch as unknown as FetchFn,
      }),
    ).rejects.toThrow("Token refresh failed (401)");
  });
});
