// src/product-loop/__tests__/discovery-schema.test.ts
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_QUESTIONS,
  isFePolicyAccepted,
  isRequiredForPlatform,
  OPTIONAL_QUESTION_IDS,
  REQUIRED_QUESTION_IDS,
  validateAnswer,
} from "../discovery-schema.js";

describe("discovery-schema", () => {
  it("has exactly 10 questions", () => {
    expect(DISCOVERY_QUESTIONS).toHaveLength(10);
  });

  it("identifies 6 required questions", () => {
    expect(REQUIRED_QUESTION_IDS.length).toBe(6);
    expect(REQUIRED_QUESTION_IDS).toContain("productType");
    expect(REQUIRED_QUESTION_IDS).toContain("backendArchitecture");
  });

  it("identifies 4 optional questions", () => {
    expect(OPTIONAL_QUESTION_IDS.length).toBe(4);
  });

  it("marks big-4 council questions correctly", () => {
    const big4 = DISCOVERY_QUESTIONS.filter((q) => q.recommendMode === "council").map((q) => q.id);
    expect(big4).toEqual(["backendArchitecture", "backendStack", "dbStrategy", "deployment"]);
  });

  it("accepts headless UI library values", () => {
    expect(isFePolicyAccepted("shadcn")).toBe(true);
    expect(isFePolicyAccepted("radix")).toBe(true);
    expect(isFePolicyAccepted("headlessui")).toBe(true);
    expect(isFePolicyAccepted("none")).toBe(true);
  });

  it("rejects image-based UI values", () => {
    expect(isFePolicyAccepted("figma-import")).toBe(false);
    expect(isFePolicyAccepted("image-derived")).toBe(false);
    expect(isFePolicyAccepted("custom-from-screenshot")).toBe(false);
  });

  it("requires frontendApproach when platform includes web", () => {
    expect(isRequiredForPlatform("frontendApproach", ["web"])).toBe(true);
    expect(isRequiredForPlatform("frontendApproach", ["cli"])).toBe(false);
    expect(isRequiredForPlatform("frontendApproach", ["mobile-ios"])).toBe(false);
  });

  it("validates productType against enum", () => {
    expect(validateAnswer("productType", "saas").ok).toBe(true);
    expect(validateAnswer("productType", "nonsense").ok).toBe(false);
  });

  it("validates audience requires persona+scale+geography", () => {
    expect(validateAnswer("audience", { persona: "devs", scale: "1k-100k", geography: "SEA" }).ok).toBe(true);
    expect(validateAnswer("audience", { persona: "devs" }).ok).toBe(false);
  });
});
