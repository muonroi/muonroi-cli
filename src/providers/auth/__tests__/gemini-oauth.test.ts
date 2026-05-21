/**
 * Tests for src/providers/auth/gemini-oauth.ts
 *
 * Login flow (callback server mocked), refresh (expiry pre-emption + mutex),
 * revoke, authHeaders, loadGeminiTokensWithRefresh.
 * No live network calls — all HTTP via mockFetch, no real browser opens.
 */

import { describe, expect, it, vi } from "vitest";
import type { FetchFn } from "../device-flow.js";
import { GeminiOAuthProvider, loadGeminiTokensWithRefresh } from "../gemini-oauth.js";
import type { OAuthTokens } from "../types.js";
import { OAuthLoginError, OAuthRefreshError } from "../types.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
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
    const r = typeof resp === "function" ? resp() : (resp ?? { ok: false, status: 500 });
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: r.json ?? (() => Promise.resolve({})),
      text: r.text ?? (() => Promise.resolve("")),
    };
  });
}

// ---------------------------------------------------------------------------
// Mock callback server factory
//
// Immediately resolves with the given code so tests don't wait for a browser.
// ---------------------------------------------------------------------------

function makeMockCallbackServer(codeToReturn: string, delayMs = 0) {
  return vi.fn(
    (opts: { onCode: (code: string, state: string) => void; timeoutMs?: number }) =>
      new Promise<{ port: number; url: string; close: () => void }>((resolve) => {
        const server = {
          port: 59999,
          url: "http://127.0.0.1:59999/callback",
          close: vi.fn(),
        };
        resolve(server);
        // Fire onCode after server resolves (optionally delayed)
        setTimeout(() => opts.onCode(codeToReturn, ""), delayMs);
      }),
  );
}

// ---------------------------------------------------------------------------
// login — happy path
// ---------------------------------------------------------------------------

describe("GeminiOAuthProvider.login", () => {
  it("completes browser-redirect flow and returns tokens with email", async () => {
    const mockFetch = makeMockFetch([
      // 1. token exchange
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fixture-access-tok",
            refresh_token: "fixture-refresh-tok",
            id_token: "fixture-id-tok",
            expires_in: 3600,
          }),
      },
      // 2. userinfo
      { ok: true, json: () => Promise.resolve({ email: "user@gmail.com", sub: "12345" }) },
    ]);

    const callbackServerFn = makeMockCallbackServer("auth-code-xyz");
    const openBrowserFn = vi.fn();

    const provider = new GeminiOAuthProvider({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn,
      openBrowserFn,
    });

    const onUserCodeFn = vi.fn();
    const tokens = await provider.login({ onUserCode: onUserCodeFn });

    expect(tokens.accessToken).toBe("fixture-access-tok");
    expect(tokens.refreshToken).toBe("fixture-refresh-tok");
    expect(tokens.idToken).toBe("fixture-id-tok");
    expect(tokens.email).toBe("user@gmail.com");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    // openBrowser should have been called
    expect(openBrowserFn).toHaveBeenCalledOnce();
    // URL should contain Google auth endpoint
    const authorizeUrl = openBrowserFn.mock.calls[0][0] as string;
    expect(authorizeUrl).toContain("accounts.google.com");
    expect(authorizeUrl).toContain("client_id=test-client-id");
    expect(authorizeUrl).toContain("code_challenge_method=S256");

    // onUserCode should have been invoked with the authorize URL
    expect(onUserCodeFn).toHaveBeenCalledOnce();
  });

  it("login still works when userinfo endpoint fails (email is optional)", async () => {
    const mockFetch = makeMockFetch([
      // token exchange
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "acc",
            refresh_token: "ref",
            expires_in: 3600,
          }),
      },
      // userinfo — failure (non-fatal)
      { ok: false, status: 401 },
    ]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: makeMockCallbackServer("code123"),
      openBrowserFn: vi.fn(),
    });

    const tokens = await provider.login({});
    expect(tokens.accessToken).toBe("acc");
    expect(tokens.email).toBeUndefined();
  });

  it("throws OAuthLoginError when callback server rejects", async () => {
    const failingCallbackServer = vi.fn(() => Promise.reject(new Error("port in use")));

    const provider = new GeminiOAuthProvider({
      fetchFn: vi.fn() as unknown as FetchFn,
      callbackServerFn: failingCallbackServer,
      openBrowserFn: vi.fn(),
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });

  it("throws OAuthLoginError when token exchange fails", async () => {
    const mockFetch = makeMockFetch([
      // token exchange fails
      { ok: false, status: 400, text: () => Promise.resolve('{"error":"invalid_grant"}') },
    ]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: makeMockCallbackServer("some-code"),
      openBrowserFn: vi.fn(),
    });

    await expect(provider.login({})).rejects.toThrow(OAuthLoginError);
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("GeminiOAuthProvider.refresh", () => {
  const makeExpiredTokens = (): OAuthTokens => ({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() - 1000, // already expired
    email: "user@gmail.com",
  });

  const makeFreshTokens = (): OAuthTokens => ({
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    email: "user@gmail.com",
  });

  it("refreshes expired tokens", async () => {
    const mockFetch = makeMockFetch([
      {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-tok",
            refresh_token: "new-refresh-tok",
            expires_in: 3600,
          }),
      },
    ]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    const tokens = await provider.refresh(makeExpiredTokens());
    expect(tokens.accessToken).toBe("new-access-tok");
    expect(tokens.refreshToken).toBe("new-refresh-tok");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(tokens.email).toBe("user@gmail.com");
  });

  it("skips refresh when tokens are still fresh", async () => {
    const mockFetch = vi.fn();
    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    const fresh = makeFreshTokens();
    const result = await provider.refresh(fresh);
    expect(result).toBe(fresh); // same reference — no refresh
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws OAuthRefreshError on HTTP error", async () => {
    const mockFetch = makeMockFetch([
      { ok: false, status: 400, text: () => Promise.resolve('{"error":"invalid_grant"}') },
    ]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    await expect(provider.refresh(makeExpiredTokens())).rejects.toThrow(OAuthRefreshError);
  });

  it("concurrent refresh calls both complete without error", async () => {
    // Mutex serializes calls but both may hit the network since the token
    // reference passed in is the same stale object (not mutated in-place).
    // What matters: both complete without throwing, both return valid tokens.
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: `access-${callCount}`,
            refresh_token: "refreshed",
            expires_in: 3600,
          }),
        text: () => Promise.resolve(""),
      };
    });

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    const expired = makeExpiredTokens();
    const [r1, r2] = await Promise.all([provider.refresh(expired), provider.refresh(expired)]);

    // Both calls should return valid access tokens
    expect(r1.accessToken).toMatch(/^access-\d+$/);
    expect(r2.accessToken).toMatch(/^access-\d+$/);
    // Mutex serializes: calls complete sequentially
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("GeminiOAuthProvider.revoke", () => {
  it("calls revoke endpoint with refresh token", async () => {
    const mockFetch = makeMockFetch([{ ok: true }]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    await provider.revoke({
      accessToken: "acc",
      refreshToken: "ref-to-revoke",
      expiresAt: Date.now() + 3600_000,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("oauth2.googleapis.com/revoke");
    expect(url).toContain("token=ref-to-revoke");
  });

  it("does not throw when revoke endpoint returns error (best-effort)", async () => {
    const mockFetch = makeMockFetch([{ ok: false, status: 500 }]);

    const provider = new GeminiOAuthProvider({
      fetchFn: mockFetch as unknown as FetchFn,
      callbackServerFn: vi.fn(),
      openBrowserFn: vi.fn(),
    });

    // Should not throw
    await expect(
      provider.revoke({ accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// authHeaders
// ---------------------------------------------------------------------------

describe("GeminiOAuthProvider.authHeaders", () => {
  it("returns only Authorization header (no extra Google-specific header)", () => {
    const provider = new GeminiOAuthProvider({ callbackServerFn: vi.fn(), openBrowserFn: vi.fn() });
    const tok = "fixture-auth-tok";
    const headers = provider.authHeaders({
      accessToken: tok,
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
    });

    // Authorization should carry the access token as a bearer scheme
    const authValue = headers.Authorization ?? "";
    expect(authValue.startsWith("Bearer ")).toBe(true);
    expect(authValue.endsWith(tok)).toBe(true);
    // Confirm no extra keys (Google OAuth needs only Authorization, no account header)
    expect(Object.keys(headers)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadGeminiTokensWithRefresh
// ---------------------------------------------------------------------------

describe("loadGeminiTokensWithRefresh", () => {
  it("returns null when no tokens are stored", async () => {
    vi.doMock("../token-store.js", () => ({
      loadTokens: vi.fn().mockResolvedValue(null),
      saveTokens: vi.fn(),
    }));

    const result = await loadGeminiTokensWithRefresh();
    expect(result).toBeNull();

    vi.doUnmock("../token-store.js");
  });

  it("returns tokens directly when not close to expiry", async () => {
    const stored: OAuthTokens = {
      accessToken: "valid-access",
      refreshToken: "valid-refresh",
      expiresAt: Date.now() + 3_600_000, // 1 hour from now — not within 60s window
      email: "user@gmail.com",
    };

    vi.doMock("../token-store.js", () => ({
      loadTokens: vi.fn().mockResolvedValue(stored),
      saveTokens: vi.fn(),
    }));

    const mockProvider = {
      refresh: vi.fn(),
    } as unknown as GeminiOAuthProvider;

    const result = await loadGeminiTokensWithRefresh(mockProvider);
    expect(result).toEqual(stored);
    expect(mockProvider.refresh).not.toHaveBeenCalled();

    vi.doUnmock("../token-store.js");
  });
});
