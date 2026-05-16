/**
 * Tests for src/providers/auth/device-flow.ts
 *
 * All HTTP calls go through a mockFetch — no live network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { exchangeCodeForTokens, generatePKCE, pollDeviceAuthorization, requestDeviceCode } from "../device-flow.js";

// ---------------------------------------------------------------------------
// generatePKCE
// ---------------------------------------------------------------------------

describe("generatePKCE", () => {
  it("returns a code_verifier between 43 and 128 chars (base64url alphabet)", () => {
    const { codeVerifier } = generatePKCE();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns a code_challenge (base64url, ~43 chars for sha256)", () => {
    const { codeChallenge } = generatePKCE();
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // sha256 base64url of 32 bytes = 43 chars
    expect(codeChallenge.length).toBe(43);
  });

  it("produces unique pairs on each call", () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

// ---------------------------------------------------------------------------
// requestDeviceCode
// ---------------------------------------------------------------------------

describe("requestDeviceCode", () => {
  it("POSTs to /api/accounts/deviceauth/usercode and returns parsed response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          device_auth_id: "deviceauth_dev_abc",
          user_code: "ABCD-1234",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          interval: "5",
        }),
    });

    const result = await requestDeviceCode({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      codeChallenge: "test_challenge",
      fetchFn: mockFetch as any,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(init.method).toBe("POST");

    expect(result.device_code).toBe("deviceauth_dev_abc");
    expect(result.user_code).toBe("ABCD-1234");
    expect(result.verification_uri).toBe("https://auth.openai.com/device");
    expect(result.interval).toBe(5);
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });

    await expect(
      requestDeviceCode({
        issuer: "https://auth.openai.com",
        clientId: "test_client",
        codeChallenge: "test_challenge",
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("400");
  });
});

// ---------------------------------------------------------------------------
// pollDeviceAuthorization
// ---------------------------------------------------------------------------

describe("pollDeviceAuthorization", () => {
  it("polls token endpoint until 200 and returns tokens (RFC 8628)", async () => {
    const pending = { error: "authorization_pending" };
    const tokens = { access_token: "acc_tok", refresh_token: "ref_tok", expires_in: 3600 };
    const responses = [
      { ok: false, status: 400, json: () => Promise.resolve(pending) },
      { ok: false, status: 400, json: () => Promise.resolve(pending) },
      { ok: true, status: 200, json: () => Promise.resolve(tokens) },
    ];
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(responses[callCount++]));

    const result = await pollDeviceAuthorization({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      deviceCode: "dev_abc",
      pollIntervalMs: 0, // instant for tests
      timeoutMs: 10_000,
      fetchFn: mockFetch as any,
    });

    expect(result.access_token).toBe("acc_tok");
    expect(result.refresh_token).toBe("ref_tok");
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify it POSTs to the token endpoint with the right body
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(sentBody.device_code).toBe("dev_abc");
    expect(sentBody.client_id).toBe("test_client");
  });

  it("throws when access_denied", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "access_denied" }),
    });

    await expect(
      pollDeviceAuthorization({
        issuer: "https://auth.openai.com",
        clientId: "test_client",
        deviceCode: "dev_abc",
        pollIntervalMs: 0,
        timeoutMs: 5_000,
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("denied");
  });

  it("throws when expired_token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "expired_token" }),
    });

    await expect(
      pollDeviceAuthorization({
        issuer: "https://auth.openai.com",
        clientId: "test_client",
        deviceCode: "dev_abc",
        pollIntervalMs: 0,
        timeoutMs: 5_000,
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("expired");
  });

  it("increases interval on slow_down and eventually succeeds", async () => {
    // Only one slow_down so the 5s bump is manageable
    const slow = { error: "slow_down" };
    const tokens = { access_token: "acc_tok", refresh_token: "ref_tok", expires_in: 3600 };
    const responses = [
      { ok: false, status: 400, json: () => Promise.resolve(slow) },
      { ok: true, status: 200, json: () => Promise.resolve(tokens) },
    ];
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(responses[callCount++]));

    const result = await pollDeviceAuthorization({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      deviceCode: "dev_abc",
      pollIntervalMs: 0,
      timeoutMs: 30_000,
      fetchFn: mockFetch as any,
    });

    expect(result.access_token).toBe("acc_tok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when timeout exceeded", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "authorization_pending" }),
    });

    await expect(
      pollDeviceAuthorization({
        issuer: "https://auth.openai.com",
        clientId: "test_client",
        deviceCode: "dev_abc",
        pollIntervalMs: 0,
        timeoutMs: 1, // 1ms — immediately times out
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("timed out");
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

describe("exchangeCodeForTokens", () => {
  it("POSTs to /oauth/token and returns token response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "mock_access_tok",
          refresh_token: "refresh_xyz",
          id_token: "mock_id_tok",
          expires_in: 3600,
          account_id: "acc_123",
        }),
    });

    const result = await exchangeCodeForTokens({
      issuer: "https://auth.openai.com",
      clientId: "test_client",
      authorizationCode: "auth_code_xyz",
      codeVerifier: "verifier_abc",
      fetchFn: mockFetch as any,
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.method).toBe("POST");

    expect(result.access_token).toBe("mock_access_tok");
    expect(result.refresh_token).toBe("refresh_xyz");
    expect(result.expires_in).toBe(3600);
  });

  it("throws on HTTP 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid_grant"),
    });

    await expect(
      exchangeCodeForTokens({
        issuer: "https://auth.openai.com",
        clientId: "test_client",
        authorizationCode: "bad_code",
        codeVerifier: "verifier",
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("400");
  });
});
