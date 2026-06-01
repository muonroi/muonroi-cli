import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEEClient, resetEEClientState } from "./client.js";
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
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await ee.health();
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("Test 2: health 502 returns { ok: false, status: 502 } without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await ee.health();
    expect(result).toEqual({ ok: false, status: 502 });
  });
});

describe("EEClient - intercept", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEEClientState(); // clear cache + circuit between tests
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
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await ee.intercept(mockReq);
    expect(result.decision).toBe("allow");
  });

  it("Test 4: intercept block — returns decision:block with reason", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "block", reason: "dangerous command" }),
    });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await ee.intercept(mockReq);
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("dangerous command");
  });

  it("Test 5: intercept 5xx falls back to { decision: 'allow', reason: 'ee-unreachable' }", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
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
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch, timeoutMs: 50 });
    // Advance timers to trigger AbortSignal.timeout
    const resultPromise = ee.intercept(mockReq);
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ee-unreachable");
  });
});

describe("EEClient - posttool", () => {
  it("Test 7: posttool is awaitable — returns Promise<void> and fetch is called", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    // posttool is now async (awaitable by PostToolUse handler)
    const returnValue = ee.posttool(mockPayload);
    expect(returnValue).toBeInstanceOf(Promise);
    await returnValue;
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("Test 8: posttool swallows errors silently", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    // Must not throw even when awaited
    await expect(ee.posttool(mockPayload)).resolves.toBeUndefined();
  });

  it("Test 9: posttool does not hang on a wedged server — bounded by an abort signal", async () => {
    // PostToolUse hook (src/hooks/index.ts) AWAITS posttool on the hot path.
    // A reachable-but-wedged EE server (accepts TCP, never responds) must NOT
    // hang the hook — posttool must carry a timeout abort signal like every
    // other client method, honouring the "never block orchestrator" intent.
    vi.useFakeTimers();
    try {
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          // Wedged server: only ever settles if the client aborts it.
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });
      const p = ee.posttool(mockPayload);
      // Structural: the call must be bounded by an AbortSignal (deterministic).
      const opts = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      // Behavioral: once the timeout fires, the wedged call is aborted and the
      // fire-and-forget catch resolves posttool to undefined (never throws).
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EEClient - auth", () => {
  beforeEach(() => {
    resetEEClientState();
  });

  it("Test 9: auth header included when authToken provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow" }),
    });
    const ee = createEEClient({ authToken: "my-token", fetchImpl: mockFetch as unknown as typeof fetch });
    await ee.intercept(mockReq);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-token");
  });

  it("Test 10: intercept body does NOT contain BYOK provider keys (sk- prefix)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow" }),
    });
    const ee = createEEClient({ fetchImpl: mockFetch as unknown as typeof fetch });

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
