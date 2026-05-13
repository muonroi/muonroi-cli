/**
 * Type-level contract tests for Phase 15 Plan 01:
 * - LeaderEvaluation gains evidenceDensity and disagreementResolved optional fields
 * - CouncilLLM gains debate() method signature
 *
 * These are compile-time-only assertions. If the file compiles cleanly, the tests pass.
 * Runtime assertions are used only where TypeScript's structural typing makes them necessary.
 */

import { describe, expect, it } from "vitest";
import type { CouncilLLM, LeaderEvaluation } from "../types.js";

describe("LeaderEvaluation type contract", () => {
  it("accepts evidenceDensity as optional number", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: false,
      criteriaStatus: [],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "test",
      evidenceDensity: 0.25,
    };
    expect(evaluation.evidenceDensity).toBe(0.25);
  });

  it("accepts disagreementResolved as optional number", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: true,
      criteriaStatus: [],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: false,
      reason: "all resolved",
      disagreementResolved: 3,
    };
    expect(evaluation.disagreementResolved).toBe(3);
  });

  it("remains backward compatible — both optional fields absent", () => {
    const evaluation: LeaderEvaluation = {
      allCriteriaMet: true,
      criteriaStatus: [{ criterion: "c1", met: true, evidence: "ok" }],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: false,
      reason: "done",
    };
    // No evidenceDensity or disagreementResolved — must compile fine
    expect(evaluation.evidenceDensity).toBeUndefined();
    expect(evaluation.disagreementResolved).toBeUndefined();
  });
});

describe("CouncilLLM.debate() method contract", () => {
  it("debate() method is part of the CouncilLLM interface", () => {
    // Structural check: create a minimal implementation that satisfies the interface.
    // If CouncilLLM does not have debate(), this will cause a compile error.
    const mockLLM: CouncilLLM = {
      generate: async () => "text",
      research: async () => "research",
      debate: async (_modelId, _system, _prompt, _signal) => ({
        text: "debate response",
        toolCalls: [{ toolName: "webSearch", result: { url: "https://example.com" } }],
      }),
    };
    expect(typeof mockLLM.debate).toBe("function");
  });

  it("debate() returns correct shape — text and toolCalls array", async () => {
    const mockLLM: CouncilLLM = {
      generate: async () => "",
      research: async () => "",
      debate: async () => ({
        text: "grounded response",
        toolCalls: [
          { toolName: "bash", result: "output" },
          { toolName: "grep" }, // result is optional
        ],
      }),
    };
    const result = await mockLLM.debate("model", "system", "prompt");
    expect(result.text).toBe("grounded response");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("bash");
    expect(result.toolCalls[1].result).toBeUndefined();
  });
});
