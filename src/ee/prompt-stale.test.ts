/**
 * src/ee/prompt-stale.test.ts
 *
 * Unit tests for reconcilePromptStale() fire-and-forget module.
 * Tests use vi.mock for getDefaultEEClient to inject mockPromptStale,
 * while using real updateLastSurfacedState/resetLastSurfacedState from intercept.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock getDefaultEEClient to inject a controllable mockPromptStale
vi.mock("./intercept.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intercept.js")>();
  return {
    ...actual,
    getDefaultEEClient: vi.fn(),
  };
});

import { getDefaultEEClient, getLastSurfacedState, resetLastSurfacedState, updateLastSurfacedState } from "./intercept.js";
import { reconcilePromptStale } from "./prompt-stale.js";

describe("reconcilePromptStale", () => {
  let mockPromptStale: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPromptStale = vi.fn().mockResolvedValue({ ok: true, unused: [], irrelevant: [], expired: [] });
    vi.mocked(getDefaultEEClient).mockReturnValue({
      promptStale: mockPromptStale,
    } as any);
  });

  afterEach(() => {
    resetLastSurfacedState();
    vi.clearAllMocks();
  });

  it("is a no-op when no surfaced IDs exist (does not call promptStale)", async () => {
    // No call to updateLastSurfacedState — surfacedIds should be []
    const result = reconcilePromptStale("/tmp");
    // Flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(result).toBeUndefined();
    expect(mockPromptStale).not.toHaveBeenCalled();
  });

  it("calls promptStale with correct payload when IDs are surfaced", async () => {
    updateLastSurfacedState(["id-1", "id-2"]);
    reconcilePromptStale("/tmp");
    // Flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(mockPromptStale).toHaveBeenCalledTimes(1);
    const [req] = mockPromptStale.mock.calls[0];
    expect(req.state.surfacedIds).toEqual(["id-1", "id-2"]);
    expect(typeof req.state.timestamp).toBe("string");
    expect(req.nextPromptMeta.trigger).toBe("auto-compact");
    expect(req.nextPromptMeta.cwd).toBe("/tmp");
    expect(req.nextPromptMeta.tenantId).toBe("local");
  });

  it("returns undefined (void, not a Promise)", () => {
    updateLastSurfacedState(["id-1"]);
    const result = reconcilePromptStale("/tmp");
    expect(result).toBeUndefined();
  });

  it("resets surfaced state BEFORE dispatching async HTTP call", async () => {
    updateLastSurfacedState(["id-1", "id-2"]);
    reconcilePromptStale("/tmp");
    // Surfaced state should be reset synchronously before async dispatch
    expect(getLastSurfacedState().surfacedIds).toEqual([]);
    // HTTP call still dispatched (can verify via flush)
    await new Promise((r) => setTimeout(r, 0));
    expect(mockPromptStale).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from rejected promptStale promise (fire-and-forget)", async () => {
    mockPromptStale.mockRejectedValue(new Error("network error"));
    updateLastSurfacedState(["id-1"]);
    // Should not throw
    expect(() => reconcilePromptStale("/tmp")).not.toThrow();
    // Allow the rejected promise to settle — should not produce unhandled rejection
    await new Promise((r) => setTimeout(r, 10));
    expect(mockPromptStale).toHaveBeenCalledTimes(1);
  });
});
