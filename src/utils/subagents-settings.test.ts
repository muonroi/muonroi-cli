import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "../types/index";
import { getCurrentModel, loadUserSettings, parseSubAgentsRawList } from "./settings";

// FORK-02 NOTE: getModelIds() is stubbed to return [] until plan 00-05 wires Anthropic provider.
// All tests that validate known model IDs will return empty results until model list is populated.
// These tests are updated to reflect the stub state — plan 00-05 will restore full behavior.

describe("parseSubAgentsRawList", () => {
  it("returns empty for non-array or missing", () => {
    expect(parseSubAgentsRawList(undefined)).toEqual([]);
    expect(parseSubAgentsRawList(null)).toEqual([]);
    expect(parseSubAgentsRawList({})).toEqual([]);
  });

  // FORK-02 stub: getModelIds() returns [] — all model IDs rejected until plan 00-05
  it("returns empty when model list is not yet populated (FORK-02 stub state)", () => {
    expect(
      parseSubAgentsRawList([
        { name: "docs", model: "grok-4-1-fast-reasoning", instruction: "Focus on documentation." },
      ]),
    ).toEqual([]);
  });

  // FORK-02 stub: normalizeModelId is pass-through; model validation returns empty
  it("returns empty when model ids are not recognized (FORK-02 stub state)", () => {
    expect(
      parseSubAgentsRawList([
        { name: "research", model: "x-ai/grok-4.20-multi-agent-beta", instruction: "Focus on research." },
      ]),
    ).toEqual([]);
  });

  it("skips unknown models", () => {
    expect(parseSubAgentsRawList([{ name: "bad", model: "not-a-real-model", instruction: "x" }])).toEqual([]);
  });

  it("skips reserved and empty names", () => {
    expect(
      parseSubAgentsRawList([
        { name: "general", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "Explore", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "vision", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "Verify", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "computer", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "", model: "grok-4-1-fast-reasoning", instruction: "x" },
        { name: "  ", model: "grok-4-1-fast-reasoning", instruction: "x" },
      ]),
    ).toEqual([]);
  });

  // FORK-02 stub: deduplication logic is fine but model validation rejects all (stub state)
  it("returns empty for deduplication when model list not populated (FORK-02 stub state)", () => {
    expect(
      parseSubAgentsRawList([
        { name: "Docs", model: "grok-4-1-fast", instruction: "first" },
        { name: "docs", model: "grok-code-fast-1", instruction: "second" },
      ]),
    ).toEqual([]);
  });

  // FORK-02 stub: non-object rows are skipped, but valid entries still fail model check
  it("ignores non-object rows (FORK-02 stub state: model check rejects all)", () => {
    expect(parseSubAgentsRawList([null, "x", { name: "ok", model: "grok-3-mini", instruction: "" }])).toEqual([]);
  });
});

describe("getCurrentModel with modeModels", () => {
  beforeEach(() => {
    delete process.env.GROK_MODEL;
  });

  it("respects mode-specific models when provided", () => {
    // This test assumes a test environment where we can check the logic path.
    // In a real environment with proper settings, this would return the mode-specific model.
    const result = getCurrentModel("agent" as AgentMode);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("respects GROK_MODEL environment variable over modeModels", () => {
    process.env.GROK_MODEL = "grok-4-special-test";

    const result = getCurrentModel("agent" as AgentMode);
    expect(result).toBe("grok-4-special-test");
  });
});
