/**
 * askcard-transcript.test.ts
 *
 * U1 — answering a council askcard used to produce two transcript records
 * (the UI's optimistic bubble + the council generator's own `↳` echo) and
 * neither carried the question — see `project_askcard_transcript_qa_pairing`
 * memory. This module builds the ONE record the UI now owns: the question as
 * `sourceLabel`, the answer as `content`. `use-app-logic.tsx` is `@ts-nocheck`
 * with no unit-test harness, so this pure helper is what's actually tested.
 */
import { describe, expect, it } from "vitest";
import type { CouncilQuestionData } from "../../types/index.js";
import { buildAskcardAnswerEntry, formatAskcardQuestionLabel } from "../askcard-transcript.js";

function question(overrides: Partial<CouncilQuestionData> = {}): CouncilQuestionData {
  return {
    questionId: "q-1",
    question: "Roslyn analyzer compile-time chuẩn hay dùng dotnet format?",
    isRequired: false,
    ...overrides,
  };
}

describe("formatAskcardQuestionLabel", () => {
  it("returns the bare question text when there is no index/total counter", () => {
    expect(formatAskcardQuestionLabel(question())).toBe("Roslyn analyzer compile-time chuẩn hay dùng dotnet format?");
  });

  it("prefixes the card's own 'n / m' counter when both are present (formatQuestionCounter passthrough)", () => {
    const label = formatAskcardQuestionLabel(question({ questionIndex: 2, questionTotal: 3 }));
    expect(label).toBe("2 / 3 · Roslyn analyzer compile-time chuẩn hay dùng dotnet format?");
  });

  it("omits the counter when only one of index/total is present", () => {
    expect(formatAskcardQuestionLabel(question({ questionIndex: 2 }))).toBe(
      "Roslyn analyzer compile-time chuẩn hay dùng dotnet format?",
    );
    expect(formatAskcardQuestionLabel(question({ questionTotal: 3 }))).toBe(
      "Roslyn analyzer compile-time chuẩn hay dùng dotnet format?",
    );
  });

  it("omits the counter for a single-question round (1 / 1 is noise, matching the live card)", () => {
    const label = formatAskcardQuestionLabel(question({ questionIndex: 1, questionTotal: 1 }));
    expect(label).toBe("Roslyn analyzer compile-time chuẩn hay dùng dotnet format?");
  });

  it("returns undefined for a missing/blank question (defensive — @ts-nocheck caller)", () => {
    expect(formatAskcardQuestionLabel(undefined)).toBeUndefined();
    expect(formatAskcardQuestionLabel(null)).toBeUndefined();
    expect(formatAskcardQuestionLabel(question({ question: "   " }))).toBeUndefined();
  });
});

describe("buildAskcardAnswerEntry", () => {
  it("produces ONE entry carrying both the question (sourceLabel) and the answer (content)", () => {
    const entry = buildAskcardAnswerEntry(
      question({ questionIndex: 2, questionTotal: 3 }),
      { kind: "choice", text: "accept" },
      { selectedOptionLabel: 'productType="internal-tool"' },
    );
    expect(entry.type).toBe("user");
    expect(entry.sourceLabel).toBe("2 / 3 · Roslyn analyzer compile-time chuẩn hay dùng dotnet format?");
    expect(entry.content).toContain("accept");
  });

  it("falls back to no sourceLabel when the question is absent, without throwing", () => {
    const entry = buildAskcardAnswerEntry(undefined, { kind: "freetext", text: "my answer" }, {});
    expect(entry.sourceLabel).toBeUndefined();
    expect(entry.content).toBe("my answer");
  });

  it("does not alter the existing answer formatting (formatAnswerForLog passthrough)", () => {
    const entry = buildAskcardAnswerEntry(question(), { kind: "chat", text: "ignored" }, {});
    expect(entry.content).toBe("[Chat about this]");
  });
});
