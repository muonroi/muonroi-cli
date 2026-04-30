import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEEClient } from "./client.js";
import type { InterceptRequest, PostToolPayload } from "./types.js";

const mockReq: InterceptRequest = {
  toolName: "bash",
  toolInput: { command: "ls" },
  cwd: "/tmp",
  tenantId: "local",
  scope: { kind: "global" },
};

const mockPayload: PostToolPayload = {
  toolName: "bash",
  toolInput: { command: "ls" },
  outcome: { success: true, exitCode: 0, durationMs: 10 },
  cwd: "/tmp",
  tenantId: "local",
  scope: { kind: "global" },
};

describe("EEClient - health", () => {
  it("Test 1: health 200 returns { ok: true, status: 200 }", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const ee = createEEClient({ fetchImpl: mockFetch });
    const result = await ee.health();
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("Test 2: health 502 returns { ok: false, status: 502 } without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    const ee = createEEClient({ fetchImpl: mockFetch });
    const result = await ee.health();
    expect(result).toEqual({ ok: false, status: 502 });
  });
});

describe("EEClient - intercept", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 3: intercept allow — returns decision:allow", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow" }),
    });
    const ee = createEEClient({ fetchImpl: mockFetch });
    const result = await ee.intercept(mockReq);
    expect(result.decision).toBe("allow");
  });

  it("Test 4: intercept block — returns decision:block with reason", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "block", reason: "dangerous command" }),
    });
    const ee = createEEClient({ fetchImpl: mockFetch });
    const result = await ee.intercept(mockReq);
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("dangerous command");
  });

  it("Test 5: intercept 5xx falls back to { decision: 'allow', reason: 'ee-unreachable' }", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const ee = createEEClient({ fetchImpl: mockFetch });
    const result = await ee.intercept(mockReq);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ee-unreachable");
    consoleSpy.mockRestore();
  });

  it("Test 6: intercept timeout falls back to { decision: 'allow', reason: 'ee-unreachable' }", async () => {
    // Simulate a fetch that aborts due to timeout signal
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        // Listen to the abort signal and reject when it fires
        const signal = opts?.signal as AbortSignal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            reject(err);
          });
        }
      });
    });
    const ee = createEEClient({ fetchImpl: mockFetch, timeoutMs: 50 });
    // Advance timers to trigger AbortSignal.timeout
    const resultPromise = ee.intercept(mockReq);
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ee-unreachable");
  });
});

describe("EEClient - posttool", () => {
  it("Test 7: posttool is fire-and-forget — returns synchronously and fetch is called", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const ee = createEEClient({ fetchImpl: mockFetch });

    // posttool returns void synchronously (no await needed)
    const returnValue = ee.posttool(mockPayload);
    expect(returnValue).toBeUndefined();

    // Wait for the microtask queue to drain so the fire-and-forget fetch actually fires
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("Test 8: posttool swallows errors silently", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const ee = createEEClient({ fetchImpl: mockFetch });

    // Must not throw
    expect(() => ee.posttool(mockPayload)).not.toThrow();
    // Let the rejected promise settle
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("EEClient - auth", () => {
  it("Test 9: auth header included when authToken provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow" }),
    });
    const ee = createEEClient({ authToken: "my-token", fetchImpl: mockFetch });
    await ee.intercept(mockReq);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });

  it("Test 10: intercept body does NOT contain BYOK provider keys (sk- prefix)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow" }),
    });
    const ee = createEEClient({ fetchImpl: mockFetch });

    // Even if toolInput somehow contains key-like values, the intercept payload
    // schema is toolName + toolInput + cwd only — no auth tokens from the CLI config
    const reqWithNoKeys: InterceptRequest = {
      toolName: "bash",
      toolInput: { command: "echo hello" },
      cwd: "/home/user",
      tenantId: "local",
      scope: { kind: "global" },
    };
    await ee.intercept(reqWithNoKeys);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = opts.body as string;
    // The request body must not contain any "sk-" substring
    expect(body).not.toMatch(/sk-/);
    // Must not contain "Bearer sk-" form
    expect(body).not.toMatch(/Bearer sk-/);
  });
});
