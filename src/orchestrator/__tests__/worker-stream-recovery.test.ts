import { APICallError } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ProviderRateLimitError } from "../../providers/rate-limit-backoff.js";
import { STALL_ABORT_REASON } from "../stall-watchdog.js";
import { isToolActivityLive } from "../tool-activity.js";
import {
  isTransientWorkerProviderError,
  retryTransientProviderCall,
  wrapToolsWithActivity,
} from "../worker-stream-recovery.js";

function apiError(statusCode: number, headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: statusCode === 503 ? "The engine is currently overloaded, please try again later" : `HTTP ${statusCode}`,
    url: "https://provider.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: '{"error":{"message":"overloaded"}}',
  });
}

describe("isTransientWorkerProviderError", () => {
  it("accepts 5xx/408 and transport drops (lively-amber-owl: HTTP 503 overloaded)", () => {
    expect(isTransientWorkerProviderError(apiError(503))).toBe(true);
    expect(isTransientWorkerProviderError(apiError(500))).toBe(true);
    expect(isTransientWorkerProviderError(apiError(408))).toBe(true);
    expect(isTransientWorkerProviderError(new Error("socket hang up"))).toBe(true);
    expect(isTransientWorkerProviderError(new Error("wrapped", { cause: apiError(502) }))).toBe(true);
  });

  it("leaves rate limits to the metered gate and never retries client errors or aborts", () => {
    expect(isTransientWorkerProviderError(apiError(429))).toBe(false);
    expect(
      isTransientWorkerProviderError(
        new ProviderRateLimitError({ provider: "p", attempts: 3, waitedMs: 1, cause: apiError(429) }),
      ),
    ).toBe(false);
    expect(isTransientWorkerProviderError(apiError(400))).toBe(false);
    expect(isTransientWorkerProviderError(apiError(401))).toBe(false);
    expect(isTransientWorkerProviderError(new DOMException("x", "AbortError"))).toBe(false);
    expect(isTransientWorkerProviderError(new DOMException(STALL_ABORT_REASON, "TimeoutError"))).toBe(false);
  });
});

describe("retryTransientProviderCall", () => {
  const noSleep = vi.fn(async () => {});

  it("re-issues the same request after a 503 and returns the retry's result", async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const out = await retryTransientProviderCall(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(503);
        return "ok";
      },
      undefined,
      { label: "m", delaysMs: [1, 1], sleep: noSleep, onRetry },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxAttempts: 3 }));
  });

  it("honours Retry-After (capped) and rethrows the ORIGINAL error once the schedule is spent", async () => {
    const sleep = vi.fn(async () => {});
    const err = apiError(503, { "retry-after": "120" });
    await expect(
      retryTransientProviderCall(
        async () => {
          throw err;
        },
        undefined,
        { label: "m", delaysMs: [5, 5], sleep },
      ),
    ).rejects.toBe(err);
    expect(sleep).toHaveBeenCalledTimes(2);
    // 120s hint is capped to the 30s transient ceiling.
    expect(sleep).toHaveBeenNthCalledWith(1, 30_000, undefined);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    const err = apiError(400);
    await expect(
      retryTransientProviderCall(
        async () => {
          calls += 1;
          throw err;
        },
        undefined,
        { label: "m", delaysMs: [1], sleep: noSleep },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});

describe("wrapToolsWithActivity", () => {
  it("marks the tool live for the stall watchdog only while it runs, within its declared timeout", async () => {
    const owned = new Set<number>();
    let liveDuring = false;
    const tools = {
      bash: {
        description: "run",
        inputSchema: {},
        execute: async () => {
          liveDuring = isToolActivityLive(Date.now(), owned);
          return "done";
        },
      },
    } as unknown as ToolSet;
    const wrapped = wrapToolsWithActivity(tools, owned);
    const exec = (wrapped.bash as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute;
    await expect(exec({ command: "dotnet test", timeout: 600_000 }, {})).resolves.toBe("done");
    expect(liveDuring).toBe(true);
    expect(owned.size).toBe(0);
    expect(isToolActivityLive(Date.now(), owned)).toBe(false);
    // The original tool object is not mutated.
    expect((tools.bash as unknown as { execute: unknown }).execute).not.toBe(
      (wrapped.bash as unknown as { execute: unknown }).execute,
    );
  });

  it("lapses once the tool overruns its own deadline plus grace", async () => {
    const owned = new Set<number>();
    let liveLater: boolean | undefined;
    const tools = {
      bash: {
        description: "run",
        inputSchema: {},
        execute: async () => {
          liveLater = isToolActivityLive(Date.now() + 1_000 + 60_000, owned);
          return "done";
        },
      },
    } as unknown as ToolSet;
    const exec = (
      wrapToolsWithActivity(tools, owned).bash as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }
    ).execute;
    await exec({ timeout: 1_000 }, {});
    expect(liveLater).toBe(false);
  });

  it("never starts a tool whose turn was already aborted (no side effects after the abort)", async () => {
    const owned = new Set<number>();
    let ran = 0;
    const tools = {
      read_file: { description: "read", inputSchema: {}, execute: async () => ++ran },
    } as unknown as ToolSet;
    const exec = (
      wrapToolsWithActivity(tools, owned).read_file as unknown as {
        execute: (i: unknown, c: unknown) => Promise<unknown>;
      }
    ).execute;
    const controller = new AbortController();
    await expect(exec({}, { abortSignal: controller.signal })).resolves.toBe(1);
    controller.abort(new DOMException("tool-failure-loop", "AbortError"));
    await expect(exec({}, { abortSignal: controller.signal })).rejects.toThrow(
      /tool_refused_turn_aborted: read_file .*tool-failure-loop/,
    );
    expect(ran).toBe(1);
    expect(owned.size).toBe(0);
  });
});
