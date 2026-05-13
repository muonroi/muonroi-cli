import { beforeEach, describe, expect, it, vi } from "vitest";
import { pilContext, resetPilContextCircuit } from "../bridge.js";

vi.mock("../client-mode.js", () => ({
  getCachedEEClientMode: () => ({ mode: "thin", baseUrl: "https://stub", token: "x" }),
}));
vi.mock("../auth.js", () => ({ getCachedServerBaseUrl: () => "https://stub" }));

const mockClient = vi.hoisted(() => ({ pilContext: vi.fn() }));
vi.mock("../intercept.js", () => ({ getDefaultEEClient: () => mockClient }));

describe("pilContext bridge wrapper", () => {
  beforeEach(() => {
    mockClient.pilContext.mockReset();
    resetPilContextCircuit();
  });

  it("returns parsed response when client succeeds", async () => {
    mockClient.pilContext.mockResolvedValueOnce({
      taskType: "debug",
      intentKind: "task",
      outputStyle: "balanced",
      confidence: 0.8,
      domain: null,
      gsd_phase: null,
      gsd_route_source: "none",
      t0_principles: [],
      t1_rules: [],
      t2_patterns: [],
      retrieval_skipped_reason: null,
      cache_hit: false,
      inference_ms: 100,
      schema_version: "1.0",
    });
    const result = await pilContext("test prompt");
    expect(result?.taskType).toBe("debug");
  });

  it("returns null on schema reject", async () => {
    mockClient.pilContext.mockResolvedValueOnce({ taskType: "debug" }); // missing required fields
    const result = await pilContext("test");
    expect(result).toBeNull();
  });

  it("returns null on client failure", async () => {
    mockClient.pilContext.mockResolvedValueOnce(null);
    const result = await pilContext("test");
    expect(result).toBeNull();
  });

  it("circuit opens after 5 failures in 30s, short-circuits 6th call", async () => {
    mockClient.pilContext.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) await pilContext("test");
    mockClient.pilContext.mockClear();
    const result = await pilContext("test");
    expect(result).toBeNull();
    expect(mockClient.pilContext).not.toHaveBeenCalled();
  });
});
