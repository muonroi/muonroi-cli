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
          device_code: "dev_abc",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.openai.com/activate",
          expires_in: 300,
          interval: 3,
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

    expect(result.device_code).toBe("dev_abc");
    expect(result.user_code).toBe("ABCD-1234");
    expect(result.verification_uri).toBe("https://auth.openai.com/activate");
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
  it("polls until status = complete and returns authorization_code", async () => {
    const responses = [
      { ok: true, json: () => Promise.resolve({ status: "pending" }) },
      { ok: true, json: () => Promise.resolve({ status: "pending" }) },
      { ok: true, json: () => Promise.resolve({ status: "complete", authorization_code: "auth_code_xyz" }) },
    ];
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(responses[callCount++]));

    const result = await pollDeviceAuthorization({
      issuer: "https://auth.openai.com",
      deviceCode: "dev_abc",
      pollIntervalMs: 0, // instant for tests
      timeoutMs: 10_000,
      fetchFn: mockFetch as any,
    });

    expect(result.authorization_code).toBe("auth_code_xyz");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws when status = denied", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "denied" }),
    });

    await expect(
      pollDeviceAuthorization({
        issuer: "https://auth.openai.com",
        deviceCode: "dev_abc",
        pollIntervalMs: 0,
        timeoutMs: 5_000,
        fetchFn: mockFetch as any,
      }),
    ).rejects.toThrow("denied");
  });

  it("throws when timeout exceeded", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "pending" }),
    });

    await expect(
      pollDeviceAuthorization({
        issuer: "https://auth.openai.com",
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
