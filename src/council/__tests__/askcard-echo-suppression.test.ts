/**
 * U1 — an answered askcard must appear in the transcript ONCE, with its
 * question. Before this fix: the UI's own optimistic bubble (answer only, no
 * question) AND the council generator's `\n  ↳ <answer>\n` echo both landed
 * in the transcript — a duplicate answer, never a question. See
 * `project_askcard_transcript_qa_pairing` memory.
 *
 * The UI side (the paired question+answer transcript record) is covered by
 * `src/ui/__tests__/askcard-transcript.test.ts` — `use-app-logic.tsx` is
 * `@ts-nocheck` with no hook-level harness. This file covers the OTHER half:
 * the council generator's echo must be SKIPPED when the answer was already
 * rendered by the interactive card, and must be KEPT for headless (which
 * never renders a card, so the echo is its only record of the answer).
 *
 * The signal: `QuestionResponder.wasAnsweredByCard(questionId)` — an optional
 * side-channel `CouncilManager.createQuestionResponder()` attaches onto the
 * function it returns, backed by whether `respondToCouncilQuestion` was
 * called WITH a `questionText` (only the interactive UI answer handler does
 * that; headless's `handleCouncilChunk` never does — see
 * `src/headless/council-answers.ts`). These tests use a bare `QuestionResponder`
 * mock — exactly what a headless-style caller passes — to prove the
 * generator's OWN default behavior (no `wasAnsweredByCard` attached at all)
 * still echoes, and a second mock WITH the method attached (mirroring what
 * the UI-wired responder provides) to prove the echo is suppressed.
 */
import { describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { runClarification } from "../clarifier.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "../types.js";

async function collectContent(gen: AsyncGenerator<StreamChunk, ClarifiedSpec, unknown>): Promise<string> {
  let text = "";
  let done = false;
  while (!done) {
    const next = await gen.next();
    if (next.done) {
      done = true;
    } else if (next.value.type === "content" && typeof next.value.content === "string") {
      text += next.value.content;
    }
  }
  return text;
}

/** One clarify question round 1, then a ready-gate verdict that stops the loop. */
function makeSingleQuestionLLM(): CouncilLLM {
  let callCount = 0;
  return {
    generate: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify([{ question: "Which analyzer profile?", why: "scope", isRequired: true }]);
      }
      if (callCount === 2) {
        // judgeReadiness verdict — stop after round 1
        return JSON.stringify({ ready: true, confidence: 0.9, gaps: [] });
      }
      // spec_synthesis
      return JSON.stringify({
        problemStatement: "topic",
        constraints: [],
        successCriteria: ["done"],
        scope: "",
      });
    }),
  } as unknown as CouncilLLM;
}

describe("U1 — clarifier echo suppression (headless vs card-answered)", () => {
  it("headless-style responder (no wasAnsweredByCard) keeps the ↳ echo — its only record of the answer", async () => {
    const headlessResponder: QuestionResponder = vi.fn().mockResolvedValue("Roslyn analyzer compile-time chuẩn");
    const gen = runClarification("topic", "leader-model", "", headlessResponder, makeSingleQuestionLLM());
    const text = await collectContent(gen);
    expect(text).toContain("↳ Roslyn analyzer compile-time chuẩn");
  });

  it("card-answered responder (wasAnsweredByCard → true) suppresses the ↳ echo — the UI already rendered the pair", async () => {
    const cardResponder: QuestionResponder = vi
      .fn()
      .mockResolvedValue("Roslyn analyzer compile-time chuẩn") as QuestionResponder;
    cardResponder.wasAnsweredByCard = vi.fn().mockReturnValue(true);
    const gen = runClarification("topic", "leader-model", "", cardResponder, makeSingleQuestionLLM());
    const text = await collectContent(gen);
    expect(text).not.toContain("↳ Roslyn analyzer compile-time chuẩn");
    expect(cardResponder.wasAnsweredByCard).toHaveBeenCalled();
  });

  it("wasAnsweredByCard → false (e.g. a headless answer routed through the same manager) still echoes", async () => {
    const responder: QuestionResponder = vi.fn().mockResolvedValue("some answer") as QuestionResponder;
    responder.wasAnsweredByCard = vi.fn().mockReturnValue(false);
    const gen = runClarification("topic", "leader-model", "", responder, makeSingleQuestionLLM());
    const text = await collectContent(gen);
    expect(text).toContain("↳ some answer");
  });
});
