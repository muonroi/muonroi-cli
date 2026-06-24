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

import { sessionRecallLedger } from "../../ee/recall-ledger.js";
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
    // Reset the process-singleton recall ledger so pending debt from a prior test
    // does not change the dynamic feedback reminder content of the next.
    sessionRecallLedger.reset();
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
    // New behavior: queryEeBridge issues 2 parallel calls (principles + behavioral).
    // The shared mock returns the same point for all three arms (principles,
    // behavioral, checkpoints).
    expect(injectedChunk?.experienceInjected?.pointCount).toBe(3);
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

  it("experience_injected chunk carries per-point {id, title, tier} so the TUI can show WHAT was injected", async () => {
    mockSearchByText.mockResolvedValue([
      {
        id: "point-1",
        score: 0.9,
        payload: { text: "Use dependency injection for testability" },
        collection: "experience-behavioral",
      },
    ]);

    await layer3EeInjection(BASE_CTX);
    const chunk = capturedSinkCalls.find(
      (c) => typeof c !== "string" && (c as StreamChunk).type === "experience_injected",
    ) as StreamChunk | undefined;

    const points = chunk?.experienceInjected?.points;
    expect(Array.isArray(points)).toBe(true);
    expect(points!.length).toBeGreaterThan(0);
    const p = points![0]!;
    expect(p.id).toBe("point-1");
    expect(p.title).toContain("dependency injection");
    expect(["principle", "behavioral", "checkpoint"]).toContain(p.tier);
  });

  it("appends an ee_feedback nudge to the injected text when rateable experience is present", async () => {
    mockSearchByText.mockResolvedValue([
      {
        id: "p1",
        score: 0.9,
        payload: { text: "Prefer composition over inheritance" },
        collection: "experience-behavioral",
      },
    ]);

    const result = await layer3EeInjection({ ...BASE_CTX, sessionId: "test-session-nudge" });
    // The dynamic pending-feedback reminder replaced the fixed nudge when the ledger
    // is enabled (default soft); it names the actual [id collection] so ee_feedback is
    // actionable. Accept either form (reminder when the ledger recorded debt, or the
    // static fallback when disabled).
    expect(result.enriched).toMatch(/ee_feedback\(id, (collection, )?followed\|ignored\|noise\)/);
    // Reminder names the actual [id collection]; the mock returns the same point in
    // both search arms so the principles arm wins first-sighting (real searches return
    // distinct points per collection) — assert id-named, collection-agnostic.
    expect(result.enriched).toMatch(/\[p1 experience-(principles|behavioral)\]/);
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
