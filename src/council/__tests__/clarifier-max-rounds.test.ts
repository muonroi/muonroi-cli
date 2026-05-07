import { describe, expect, it, vi } from "vitest";
import { runClarification } from "../clarifier.js";
import type { CouncilLLM, QuestionResponder } from "../types.js";
import type { StreamChunk } from "../../types/index.js";

describe("runClarification maxRounds parameterization", () => {
  const mockLLM: CouncilLLM = {
    generate: vi.fn().mockResolvedValue('["Next question?"]')
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
      6 // maxRounds
    );

    for await (const chunk of gen) {
      if (chunk.type === "council_phase" && chunk.councilPhase?.kind === "clarification_round" && chunk.councilPhase.state === "active") {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    // Since mockLLM always returns a question, it should iterate exactly maxRounds times
    expect(rounds.length).toBe(6);
  });

  it("defaults to 3 rounds when maxRounds is not provided", async () => {
    const rounds: string[] = [];
    const gen = runClarification(
      "topic",
      "model",
      "context",
      mockResponder,
      mockLLM,
      undefined,
      undefined
      // maxRounds omitted
    );

    for await (const chunk of gen) {
      if (chunk.type === "council_phase" && chunk.councilPhase?.kind === "clarification_round" && chunk.councilPhase.state === "active") {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    expect(rounds.length).toBe(3);
  });

  it("falls back to 3 rounds when maxRounds is non-positive", async () => {
    const rounds: string[] = [];
    const gen = runClarification(
      "topic",
      "model",
      "context",
      mockResponder,
      mockLLM,
      undefined,
      undefined,
      -1 // invalid maxRounds
    );

    for await (const chunk of gen) {
      if (chunk.type === "council_phase" && chunk.councilPhase?.kind === "clarification_round" && chunk.councilPhase.state === "active") {
        rounds.push(chunk.councilPhase.phaseId);
      }
    }

    expect(rounds.length).toBe(3);
  });
});
