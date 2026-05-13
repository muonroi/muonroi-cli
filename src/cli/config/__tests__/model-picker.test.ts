import { describe, expect, it } from "vitest";
import type { PickerModel } from "../model-picker.js";
import { filterModels, groupModels } from "../model-picker.js";

const SAMPLE: PickerModel[] = [
  { id: "claude-opus-4-7", displayName: "claude-opus-4-7", provider: "anthropic", tier: "premium", capability: "text" },
  { id: "gpt-4o", displayName: "gpt-4o", provider: "openai", tier: "premium", capability: "text" },
  { id: "gpt-4-vision", displayName: "gpt-4-vision", provider: "openai", tier: "premium", capability: "vision" },
  { id: "FLUX.1", displayName: "FLUX.1", provider: "siliconflow", capability: "image" },
  { id: "deepseek-v3", displayName: "deepseek-v3", provider: "deepseek", tier: "balanced", capability: "text" },
];

describe("filterModels", () => {
  it("returns all models when query is empty", () => {
    expect(filterModels(SAMPLE, "")).toHaveLength(5);
  });
  it("filters by id substring (case-insensitive)", () => {
    const result = filterModels(SAMPLE, "gpt");
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.id.toLowerCase().includes("gpt"))).toBe(true);
  });
  it("filters by provider", () => {
    const result = filterModels(SAMPLE, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("claude-opus-4-7");
  });
  it("returns empty when no match", () => {
    expect(filterModels(SAMPLE, "zzz")).toHaveLength(0);
  });
  it("filters by tier", () => {
    const result = filterModels(SAMPLE, "balanced");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("deepseek-v3");
  });
});

describe("groupModels", () => {
  it("puts vision capability models into Vision group", () => {
    const groups = groupModels(SAMPLE);
    const visionGroup = groups.find((g) => g.name === "Vision / Multimodal");
    expect(visionGroup?.models).toHaveLength(1);
    expect(visionGroup?.models[0]?.id).toBe("gpt-4-vision");
  });
  it("puts image capability models into Image group", () => {
    const groups = groupModels(SAMPLE);
    const imageGroup = groups.find((g) => g.name === "Image Generation");
    expect(imageGroup?.models).toHaveLength(1);
  });
  it("puts text capability models into Text / Chat group", () => {
    const groups = groupModels(SAMPLE);
    const textGroup = groups.find((g) => g.name === "Text / Chat");
    expect(textGroup?.models).toHaveLength(3);
  });
  it("omits groups with no models", () => {
    const textOnly = SAMPLE.filter((m) => m.capability === "text");
    const groups = groupModels(textOnly);
    expect(groups.every((g) => g.models.length > 0)).toBe(true);
  });
});
