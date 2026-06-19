// Dual-run validator: ensures legacy and unified paths produce equivalent
// classifications on a representative fixture set. Divergence > 10% fails.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the EE bridge so both legacy and unified paths behave identically
// in CI (no experience-engine server available). Without this, unified=1
// triggers a real HTTP call that either times out (exceeding the 200ms pipeline
// timeout) or returns null — producing different taskType results from legacy=0,
// which skips the HTTP call entirely.
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  routeTask: vi.fn().mockResolvedValue(null),
  pilContext: vi.fn().mockResolvedValue(null),
  getWhoAmIProfile: vi.fn(() => null),
  outputStyleFromProfile: vi.fn(() => null),
}));

const FIXTURES = [
  "tại sao test fail?",
  "refactor this function",
  "thiết kế hệ thống auth cho team 3 người",
  "hi",
  "fix the bug in login flow",
  "explain this regex /^\\d+$/",
  "write docs for the API endpoint",
  "generate a TypeScript Zod schema for User",
  "phân tích lỗi memory leak trong service",
  "ok thanks",
];

describe("Dual-run: unified vs legacy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("classification matches in ≥90% of fixtures", async () => {
    process.env.MUONROI_PIL_UNIFIED = "0";
    const { runPipeline: runLegacy } = await import("../pipeline.js");
    const legacyResults = await Promise.all(FIXTURES.map((p) => runLegacy(p)));

    vi.resetModules();
    process.env.MUONROI_PIL_UNIFIED = "1";
    const { runPipeline: runUnified } = await import("../pipeline.js");
    const unifiedResults = await Promise.all(FIXTURES.map((p) => runUnified(p)));

    let matches = 0;
    for (let i = 0; i < FIXTURES.length; i++) {
      if (legacyResults[i].taskType === unifiedResults[i].taskType) matches++;
    }
    const matchRate = matches / FIXTURES.length;
    expect(matchRate).toBeGreaterThanOrEqual(0.9);
  });
});
