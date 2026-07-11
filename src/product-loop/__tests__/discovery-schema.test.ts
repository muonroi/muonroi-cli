// src/product-loop/__tests__/discovery-schema.test.ts
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_QUESTIONS,
  getSchemaHintForLeader,
  isAgentHarnessAccepted,
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

  it("frontendApproach.agentHarness — accepts all five wrapper values", () => {
    expect(isAgentHarnessAccepted("react")).toBe(true);
    expect(isAgentHarnessAccepted("angular")).toBe(true);
    expect(isAgentHarnessAccepted("opentui")).toBe(true);
    expect(isAgentHarnessAccepted("core")).toBe(true);
    expect(isAgentHarnessAccepted("none")).toBe(true);
  });

  it("frontendApproach.agentHarness — rejects unknown wrapper values", () => {
    expect(isAgentHarnessAccepted("vue")).toBe(false);
    expect(isAgentHarnessAccepted("svelte")).toBe(false);
    expect(isAgentHarnessAccepted("")).toBe(false);
  });

  it("validateAnswer frontendApproach — accepts when agentHarness omitted (back-compat)", () => {
    expect(validateAnswer("frontendApproach", { library: "shadcn", framework: "next" }).ok).toBe(true);
  });

  it("validateAnswer frontendApproach — accepts when agentHarness is a known wrapper", () => {
    expect(validateAnswer("frontendApproach", { library: "shadcn", framework: "next", agentHarness: "react" }).ok).toBe(
      true,
    );
  });

  it("validateAnswer frontendApproach — rejects when agentHarness is a bogus wrapper", () => {
    const result = validateAnswer("frontendApproach", { library: "shadcn", framework: "next", agentHarness: "vue" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/agentHarness/);
  });

  it("schema hint mentions the agentHarness slot and all five wrapper values", () => {
    const hint = getSchemaHintForLeader("frontendApproach");
    expect(hint).toContain("agentHarness");
    expect(hint).toContain('"react"');
    expect(hint).toContain('"angular"');
    expect(hint).toContain('"opentui"');
    expect(hint).toContain('"core"');
    expect(hint).toContain('"none"');
  });

  it("dbStrategy offers a stateless 'none' option so the recommender stops defaulting to greenfield (F7)", () => {
    const q = DISCOVERY_QUESTIONS.find((x) => x.id === "dbStrategy")!;
    // The question the recommender reads must offer 'none' for stateless products.
    expect(q.prompt.toLowerCase()).toContain("none");
    expect(q.prompt.toLowerCase()).toContain("stateless");

    const hint = getSchemaHintForLeader("dbStrategy");
    expect(hint).toContain('"none"');
    expect(hint).toContain('"greenfield"');
    // The hint must actively steer away from greenfield for no-persistence products.
    expect(hint.toLowerCase()).toContain("do not default to");
  });
});
