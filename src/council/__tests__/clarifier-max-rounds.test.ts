import { describe, expect, it, vi } from "vitest";
import { MAX_CLARIFY_ROUNDS, runClarification } from "../clarifier.js";
import type { CouncilLLM, QuestionResponder } from "../types.js";

describe("runClarification maxRounds parameterization", () => {
  const mockLLM: CouncilLLM = {
    generate: vi.fn().mockResolvedValue('["Next question?"]'),
  } as any;

  const mockResponder: QuestionResponder = vi.fn().mockResolvedValue("answer");

  it("respects maxRounds=6 when provided", async () => {
    const rounds: string[] = [];
    const gen = runClarification(
      "topic",
      "model",
      "context",
      mockResponder,
      mockLLM,
      undefined,
      undefined,
      6, // maxRounds
    );

    for await (const chunk of gen) {
      if (
        chunk.type === "council_phase" &&
        chunk.councilPhase?.kind === "clarification_round" &&
        chunk.councilPhase.state === "active"
      ) {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    // Since mockLLM always returns a question, it should iterate exactly maxRounds times
    expect(rounds.length).toBe(6);
  });

  it("defaults to MAX_CLARIFY_ROUNDS when maxRounds is not provided", async () => {
    const rounds: string[] = [];
    const gen = runClarification(
      "topic",
      "model",
      "context",
      mockResponder,
      mockLLM,
      undefined,
      undefined,
      // maxRounds omitted — P5: default is MAX_CLARIFY_ROUNDS (12)
    );

    for await (const chunk of gen) {
      if (
        chunk.type === "council_phase" &&
        chunk.councilPhase?.kind === "clarification_round" &&
        chunk.councilPhase.state === "active"
      ) {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    expect(rounds.length).toBe(MAX_CLARIFY_ROUNDS);
  });

  it("falls back to MAX_CLARIFY_ROUNDS when maxRounds is non-positive", async () => {
    const rounds: string[] = [];
    const gen = runClarification(
      "topic",
      "model",
      "context",
      mockResponder,
      mockLLM,
      undefined,
      undefined,
      -1, // invalid maxRounds
    );

    for await (const chunk of gen) {
      if (
        chunk.type === "council_phase" &&
        chunk.councilPhase?.kind === "clarification_round" &&
        chunk.councilPhase.state === "active"
      ) {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    expect(rounds.length).toBe(MAX_CLARIFY_ROUNDS);
  });
});
