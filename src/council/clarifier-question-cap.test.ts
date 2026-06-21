/**
 * src/council/clarifier-question-cap.test.ts
 *
 * G2-a regression backstop. The clarifier prompt asks for "typically 0-2"
 * questions and tells the model NOT to ask generic greenfield questions in an
 * existing repo, but the model has repeatedly ignored both (session
 * cfc711c57df0: 6 generic greenfield questions on "improve council quality").
 * capClarifierQuestions enforces this deterministically in code. These tests
 * pin that behaviour; the live council surfacing is verified via the MCP
 * harness separately.
 */

import { describe, expect, it } from "vitest";
import { capClarifierQuestions, isGenericGreenfieldQuestion, MAX_CLARIFY_QUESTIONS_PER_ROUND } from "./clarifier.js";

type Q = { question: string; why?: string };

const scoped = (n: number): Q[] =>
  Array.from({ length: n }, (_, i) => ({ question: `Scoped decision ${i} for this change?`, why: "scope" }));

describe("isGenericGreenfieldQuestion", () => {
  it("matches generic greenfield questions (English)", () => {
    expect(isGenericGreenfieldQuestion({ question: "Who is the target audience?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "Which programming language should we use?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "Which database do you want?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "What is the deployment target?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "What kind of product is this?" })).toBe(true);
  });

  it("matches generic greenfield questions (Vietnamese)", () => {
    expect(isGenericGreenfieldQuestion({ question: "Đối tượng người dùng là ai?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "Dùng ngôn ngữ lập trình nào?" })).toBe(true);
    expect(isGenericGreenfieldQuestion({ question: "Cơ sở dữ liệu nào phù hợp?" })).toBe(true);
  });

  it("does NOT match scoped, change-specific questions", () => {
    expect(isGenericGreenfieldQuestion({ question: "Should the clarifier cap be configurable?" })).toBe(false);
    expect(isGenericGreenfieldQuestion({ question: "Phạm vi của thay đổi này là gì?", why: "scope" })).toBe(false);
    expect(isGenericGreenfieldQuestion({ question: "Do we keep backward compat for the old flag?" })).toBe(false);
  });
});

describe("capClarifierQuestions", () => {
  it("hard-caps to MAX_CLARIFY_QUESTIONS_PER_ROUND when the model over-asks", () => {
    const { kept, dropped } = capClarifierQuestions(scoped(6), false);
    expect(kept.length).toBe(MAX_CLARIFY_QUESTIONS_PER_ROUND);
    expect(dropped).toBe(6 - MAX_CLARIFY_QUESTIONS_PER_ROUND);
  });

  it("leaves a compliant 0-2 round untouched", () => {
    expect(capClarifierQuestions(scoped(2), false)).toEqual({ kept: scoped(2), dropped: 0 });
    expect(capClarifierQuestions([], false)).toEqual({ kept: [], dropped: 0 });
  });

  it("existing repo: drops generic greenfield questions then caps the rest", () => {
    const qs: Q[] = [
      { question: "Who is the target audience?" },
      { question: "Which framework should we use?" },
      { question: "Should we preserve the legacy --flag for this change?" },
      { question: "Is the cap value configurable via settings?" },
    ];
    const { kept, dropped } = capClarifierQuestions(qs, true);
    expect(kept.every((q) => !isGenericGreenfieldQuestion(q))).toBe(true);
    expect(kept.length).toBe(2); // 2 generic dropped → 2 scoped remain, within cap
    expect(dropped).toBe(2);
  });

  it("existing repo: never zeroes out a round — keeps the top pick if all look generic", () => {
    const allGeneric: Q[] = [
      { question: "Who is the target audience?" },
      { question: "Which database?" },
      { question: "What kind of product is this?" },
    ];
    const { kept, dropped } = capClarifierQuestions(allGeneric, true);
    expect(kept.length).toBe(1);
    expect(dropped).toBe(2);
  });

  it("greenfield topic (no Current Project snapshot): does NOT drop generics, only caps", () => {
    const qs: Q[] = [{ question: "Who is the target audience?" }, { question: "Which language?" }];
    const { kept, dropped } = capClarifierQuestions(qs, false);
    expect(kept.length).toBe(2); // legitimate for a greenfield build
    expect(dropped).toBe(0);
  });
});
