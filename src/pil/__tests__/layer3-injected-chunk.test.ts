/**
 * layer3-injected-chunk.test.ts
 *
 * CQ-16b regression tests: layer3EeInjection emits experience_injected StreamChunk
 * when searchByText returns high-score points. Verifies observable sink behavior
 * locked after Wave 1/3 changes to layer3-ee-injection.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";

// Hoisted so mocks can reference them before module initialization
const mockSearchByText = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const capturedSinkCalls: Array<string | StreamChunk> = [];

vi.mock("../../ee/bridge.js", () => ({
  searchByText: mockSearchByText,
}));

vi.mock("../../ee/render.js", () => ({
  getRenderSink: vi.fn(() => (c: string | StreamChunk) => capturedSinkCalls.push(c)),
  setRenderSink: vi.fn(),
}));

// Mock interaction-log to prevent DB writes in tests
vi.mock("../../storage/interaction-log.js", () => ({
  logInteraction: vi.fn(),
}));

// Mock intercept (updateLastSurfacedState)
vi.mock("../../ee/intercept.js", () => ({
  updateLastSurfacedState: vi.fn(),
}));

import { layer3EeInjection } from "../layer3-ee-injection.js";
import type { PipelineContext } from "../types.js";

const BASE_CTX: PipelineContext = {
  raw: "test prompt for experience injection",
  enriched: "",
  layers: [],
  tokenBudget: 4096,
  sessionId: "test-session",
  taskType: "general",
  domain: "frontend",
  outputStyle: null,
  confidence: 0.8,
  metrics: null,
};

describe("layer3 experience_injected chunk emission (CQ-16b)", () => {
  beforeEach(() => {
    capturedSinkCalls.length = 0;
    mockSearchByText.mockResolvedValue([]);
  });

  it("emits experience_injected chunk when searchByText returns high-score point", async () => {
    mockSearchByText.mockResolvedValue([
      {
        id: "point-1",
        score: 0.9,
        payload: { text: "Use dependency injection for testability" },
        collection: "experience-behavioral",
      },
    ]);

    await layer3EeInjection(BASE_CTX);

    const injectedChunk = capturedSinkCalls.find(
      (c) => typeof c !== "string" && (c as StreamChunk).type === "experience_injected",
    ) as StreamChunk | undefined;

    expect(injectedChunk).toBeDefined();
    expect(injectedChunk?.type).toBe("experience_injected");
    expect(injectedChunk?.experienceInjected?.pointCount).toBe(1);
    expect(injectedChunk?.experienceInjected?.pointIds).toContain("point-1");
  });

  it("experience_injected chunk carries scoreFloor as a number", async () => {
    mockSearchByText.mockResolvedValue([
      {
        id: "p1",
        score: 0.9,
        payload: { text: "hint text" },
        collection: "experience-behavioral",
      },
    ]);

    await layer3EeInjection(BASE_CTX);

    const chunk = capturedSinkCalls.find(
      (c) => typeof c !== "string" && (c as StreamChunk).type === "experience_injected",
    ) as StreamChunk | undefined;

    expect(chunk?.experienceInjected?.scoreFloor).toBeDefined();
    expect(typeof chunk?.experienceInjected?.scoreFloor).toBe("number");
  });

  it("does NOT emit experience_injected when searchByText returns empty array", async () => {
    mockSearchByText.mockResolvedValue([]);

    await layer3EeInjection(BASE_CTX);

    const injectedChunk = capturedSinkCalls.find(
      (c) => typeof c !== "string" && (c as StreamChunk).type === "experience_injected",
    );
    expect(injectedChunk).toBeUndefined();
  });

  it("does NOT emit experience_injected when searchByText throws (error path)", async () => {
    mockSearchByText.mockRejectedValue(new Error("VPS unreachable"));

    await layer3EeInjection(BASE_CTX);

    const injectedChunk = capturedSinkCalls.find(
      (c) => typeof c !== "string" && (c as StreamChunk).type === "experience_injected",
    );
    expect(injectedChunk).toBeUndefined();
  });
});
