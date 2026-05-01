import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMode } from "../types/index";
import { getCurrentModel, parseSubAgentsRawList } from "./settings";

describe("parseSubAgentsRawList", () => {
  it("returns empty for non-array or missing", () => {
    expect(parseSubAgentsRawList(undefined)).toEqual([]);
    expect(parseSubAgentsRawList(null)).toEqual([]);
    expect(parseSubAgentsRawList({})).toEqual([]);
  });

  it("returns empty when model list is not yet populated", () => {
    expect(
      parseSubAgentsRawList([
        { name: "docs", model: "grok-4-1-fast-reasoning", instruction: "Focus on documentation." },
      ]),
    ).toEqual([]);
  });

  it("returns empty when model ids are not recognized", () => {
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

  it("returns empty for deduplication when model list not populated", () => {
    expect(
      parseSubAgentsRawList([
        { name: "Docs", model: "grok-4-1-fast", instruction: "first" },
        { name: "docs", model: "grok-code-fast-1", instruction: "second" },
      ]),
    ).toEqual([]);
  });

  it("ignores non-object rows", () => {
    expect(parseSubAgentsRawList([null, "x", { name: "ok", model: "grok-3-mini", instruction: "" }])).toEqual([]);
  });
});

describe("getCurrentModel with modeModels", () => {
  beforeEach(() => {
    delete process.env.MUONROI_MODEL;
  });

  it("respects mode-specific models when provided", () => {
    const result = getCurrentModel("agent" as AgentMode);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("respects MUONROI_MODEL environment variable over modeModels", () => {
    process.env.MUONROI_MODEL = "claude-sonnet-4-6-20250514";

    const result = getCurrentModel("agent" as AgentMode);
    expect(result).toBe("claude-sonnet-4-6-20250514");
  });
});
