/**
 * U1 — `_cardAnsweredQuestionIds` leak (CouncilManager).
 *
 * `collectSpecEdit` and the launch-card edit loop (both `council/index.ts`,
 * `phase: "council-setup"`) never echo their answer back to the transcript,
 * so nothing was ever calling `QuestionResponder.wasAnsweredByCard` for their
 * questionIds — every card the interactive UI answered through them stayed
 * in `CouncilManager._cardAnsweredQuestionIds` forever. This file pins two
 * independent guarantees:
 *
 *  1. `collectSpecEdit`, driven end-to-end against a REAL `CouncilManager`
 *     (not a mock — the actual production class), leaves nothing behind
 *     after both of its questions are answered "through the card" (i.e. with
 *     `questionText`, exactly like `use-app-logic.tsx`'s answer handler).
 *  2. As defense-in-depth, `CouncilManager` bounds the set at
 *     `MAX_CARD_ANSWERED_IDS` even for a hypothetical FUTURE call site that
 *     forgets to drain — verified by driving it past the cap and confirming
 *     it never exceeds that bound.
 *
 * The launch-card edit loop's own drain call is NOT separately exercised
 * here — it is deeply embedded in `runCouncil` (leader resolution, panel
 * selection, debate planning, …) and not practically unit-testable in
 * isolation. It uses the IDENTICAL mechanism this file pins
 * (`respondToQuestion.wasAnsweredByCard?.(id)` immediately after each
 * `await respondToQuestion(...)`), reviewed by hand against this same
 * contract — see `council/index.ts`'s launch-card loop, the comment beside
 * `respondToQuestion.wasAnsweredByCard?.(setupQuestionId)`.
 */

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { CouncilManager, type CouncilManagerDeps, MAX_CARD_ANSWERED_IDS } from "../../orchestrator/council-manager";
import type { BashTool } from "../../tools/bash";
import type { StreamChunk } from "../../types/index.js";
import { collectSpecEdit } from "../index.js";
import type { ClarifiedSpec, QuestionResponder } from "../types.js";

function makeDeps(): CouncilManagerDeps {
  return {
    getModelId: () => "test-model",
    getSessionId: () => null,
    hasSessionStore: () => false,
    getMessages: () => [] as ReadonlyArray<ModelMessage>,
    getBash: () => ({ getCwd: () => process.cwd() }) as unknown as BashTool,
    getMode: () => "agent",
  };
}

const spec: ClarifiedSpec = {
  problemStatement: "Original topic",
  constraints: [],
  successCriteria: ["Original criterion"],
  scope: "",
  rawQA: [],
};

describe("U1 — CouncilManager._cardAnsweredQuestionIds does not leak", () => {
  let manager: CouncilManager;
  let respondToQuestion: QuestionResponder;

  beforeEach(() => {
    manager = new CouncilManager(makeDeps());
    respondToQuestion = manager.createQuestionResponder();
  });

  it("collectSpecEdit — answering both council-setup questions THROUGH THE CARD leaves nothing behind", async () => {
    const gen = collectSpecEdit(spec, "session-1", 1, respondToQuestion);
    let step = await gen.next();
    while (!step.done) {
      const chunk = step.value as StreamChunk;
      if (chunk.type === "council_question" && chunk.councilQuestion) {
        const { questionId, question } = chunk.councilQuestion;
        // Mirrors exactly what use-app-logic.tsx's answer handler does: pass
        // questionText, which is what marks this id "answered via card".
        manager.respondToQuestion(questionId, "an edited value", question);
      }
      step = await gen.next();
    }
    expect(manager._cardAnsweredCountForTests()).toBe(0);
  });

  it("collectSpecEdit — a headless-style answer (no questionText) never enters the set at all", async () => {
    const gen = collectSpecEdit(spec, "session-2", 1, respondToQuestion);
    let step = await gen.next();
    while (!step.done) {
      const chunk = step.value as StreamChunk;
      if (chunk.type === "council_question" && chunk.councilQuestion) {
        manager.respondToQuestion(chunk.councilQuestion.questionId, "an edited value");
      }
      step = await gen.next();
    }
    expect(manager._cardAnsweredCountForTests()).toBe(0);
  });

  it("defense-in-depth: the set never exceeds MAX_CARD_ANSWERED_IDS even when nothing drains it", () => {
    for (let i = 0; i < MAX_CARD_ANSWERED_IDS + 50; i++) {
      manager.respondToQuestion(`unconsumed-${i}`, "answer", `question ${i}`);
    }
    expect(manager._cardAnsweredCountForTests()).toBeLessThanOrEqual(MAX_CARD_ANSWERED_IDS);
  });
});
