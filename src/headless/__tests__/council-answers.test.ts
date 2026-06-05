import { describe, expect, it, vi } from "vitest";
import type { CouncilQuestionData } from "../../types/index.js";
import {
  createCouncilAutoAnswerer,
  createHeadlessCouncilAutoAnswerer,
  handleCouncilChunk,
  parseCouncilAnswersFile,
} from "../council-answers.js";

function q(over: Partial<CouncilQuestionData>): CouncilQuestionData {
  return {
    questionId: "qid",
    question: "?",
    isRequired: false,
    ...over,
  };
}

describe("parseCouncilAnswersFile", () => {
  it("parses a valid object with phase queues + preflightApprove", () => {
    const out = parseCouncilAnswersFile(
      JSON.stringify({
        clarify: ["python", "mongo"],
        "post-debate": ["generate_plan"],
        preflightApprove: false,
      }),
    );
    expect(out.clarify).toEqual(["python", "mongo"]);
    expect(out["post-debate"]).toEqual(["generate_plan"]);
    expect(out.preflightApprove).toBe(false);
  });

  it("rejects non-object root", () => {
    expect(() => parseCouncilAnswersFile(JSON.stringify(["x"]))).toThrow(/object/);
    expect(() => parseCouncilAnswersFile(JSON.stringify(42))).toThrow(/object/);
  });

  it("rejects non-string entries in a phase queue", () => {
    expect(() => parseCouncilAnswersFile(JSON.stringify({ clarify: [1, 2] }))).toThrow(/clarify/);
  });

  it("rejects non-boolean preflightApprove", () => {
    expect(() => parseCouncilAnswersFile(JSON.stringify({ preflightApprove: "yes" }))).toThrow(/preflightApprove/);
  });

  it("accepts an empty object", () => {
    expect(parseCouncilAnswersFile("{}")).toEqual({});
  });
});

describe("createCouncilAutoAnswerer", () => {
  it("returns null when neither enabled nor file is provided", () => {
    expect(createCouncilAutoAnswerer({ enabled: false })).toBeNull();
  });

  it("--yes alone picks defaultIndex value", () => {
    const a = createCouncilAutoAnswerer({ enabled: true });
    expect(a).not.toBeNull();
    const answer = a!.answerQuestion(
      q({
        phase: "post-debate",
        defaultIndex: 1,
        options: [
          { label: "A", value: "a", kind: "choice" },
          { label: "B", value: "b", kind: "choice" },
        ],
      }),
    );
    expect(answer).toBe("b");
  });

  it("falls back to first option when defaultIndex is out of range", () => {
    const a = createCouncilAutoAnswerer({ enabled: true });
    const answer = a!.answerQuestion(
      q({
        phase: "post-debate",
        defaultIndex: 99,
        options: [
          { label: "A", value: "a", kind: "choice" },
          { label: "B", value: "b", kind: "choice" },
        ],
      }),
    );
    expect(answer).toBe("a");
  });

  it("returns empty string for freetext questions with no options", () => {
    const a = createCouncilAutoAnswerer({ enabled: true });
    expect(a!.answerQuestion(q({ phase: "clarify" }))).toBe("");
  });

  it("scripted answers consume FIFO per phase", () => {
    const a = createCouncilAutoAnswerer({
      enabled: false,
      file: { clarify: ["first", "second"] },
    });
    expect(a!.answerQuestion(q({ phase: "clarify" }))).toBe("first");
    expect(a!.answerQuestion(q({ phase: "clarify" }))).toBe("second");
    // Queue exhausted → fall back to default (empty string for freetext).
    expect(a!.answerQuestion(q({ phase: "clarify" }))).toBe("");
  });

  it("scripted queue for one phase does not bleed into another", () => {
    const a = createCouncilAutoAnswerer({
      enabled: false,
      file: { clarify: ["c1"], "post-debate": ["pd1"] },
    });
    expect(a!.answerQuestion(q({ phase: "post-debate" }))).toBe("pd1");
    expect(a!.answerQuestion(q({ phase: "clarify" }))).toBe("c1");
  });

  it("preflight approval defaults to true", () => {
    const a = createCouncilAutoAnswerer({ enabled: true });
    expect(a!.approvePreflight()).toBe(true);
  });

  it("preflight approval honors preflightApprove: false", () => {
    const a = createCouncilAutoAnswerer({
      enabled: false,
      file: { preflightApprove: false },
    });
    expect(a!.approvePreflight()).toBe(false);
  });

  it("preserves caller's file by deep-copying queues", () => {
    const file = { clarify: ["a", "b"] };
    const a = createCouncilAutoAnswerer({ enabled: false, file });
    a!.answerQuestion(q({ phase: "clarify" }));
    // The caller's queue must remain intact.
    expect(file.clarify).toEqual(["a", "b"]);
  });
});

describe("createHeadlessCouncilAutoAnswerer (headless never hangs)", () => {
  it("ALWAYS returns an active answerer even with no file and no --yes", () => {
    // Regression: previously headless gated the answerer on `--yes`, so a prompt
    // that triggered council without --yes left the responder promise unresolved
    // and the process hung forever (0 output). Headless has no TUI to answer, so
    // the answerer must always be present and auto-proceed with the recommended
    // (defaultIndex) option.
    const a = createHeadlessCouncilAutoAnswerer({});
    expect(a).not.toBeNull();
    const answer = a.answerQuestion(
      q({
        phase: "post-debate",
        defaultIndex: 1,
        options: [
          { label: "A", value: "a", kind: "choice" },
          { label: "B", value: "b", kind: "choice" },
        ],
      }),
    );
    expect(answer).toBe("b"); // recommended (defaultIndex) option
    expect(a.approvePreflight()).toBe(true);
  });

  it("still honors a scripted --council-answers file", () => {
    const a = createHeadlessCouncilAutoAnswerer({ file: { clarify: ["mongo"] } });
    expect(a.answerQuestion(q({ phase: "clarify" }))).toBe("mongo");
  });
});

describe("handleCouncilChunk (interception wiring)", () => {
  function makeSink() {
    return {
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
    };
  }

  it("returns null and is a no-op when answerer is null", () => {
    const sink = makeSink();
    const out = handleCouncilChunk({ type: "council_question", councilQuestion: q({ phase: "clarify" }) }, null, sink);
    expect(out).toBeNull();
    expect(sink.respondToQuestion).not.toHaveBeenCalled();
  });

  it("returns null for non-askcard chunks", () => {
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({ enabled: true });
    const out = handleCouncilChunk({ type: "content" }, a, sink);
    expect(out).toBeNull();
    expect(sink.respondToQuestion).not.toHaveBeenCalled();
    expect(sink.respondToPreflight).not.toHaveBeenCalled();
  });

  it("calls respondToQuestion with the resolved answer for a clarify chunk", () => {
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({
      enabled: false,
      file: { clarify: ["mongo"] },
    });
    const audit = handleCouncilChunk(
      {
        type: "council_question",
        councilQuestion: q({ phase: "clarify", questionId: "q-1" }),
      },
      a,
      sink,
    );
    expect(sink.respondToQuestion).toHaveBeenCalledWith("q-1", "mongo");
    expect(audit).toContain("clarify → mongo");
  });

  it("calls respondToQuestion with defaultIndex value when --yes only", () => {
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({ enabled: true });
    handleCouncilChunk(
      {
        type: "council_question",
        councilQuestion: q({
          phase: "post-debate",
          questionId: "q-2",
          defaultIndex: 0,
          options: [
            { label: "Continue", value: "continue", kind: "choice" },
            { label: "Stop", value: "stop", kind: "choice" },
          ],
        }),
      },
      a,
      sink,
    );
    expect(sink.respondToQuestion).toHaveBeenCalledWith("q-2", "continue");
  });

  it("approves preflight chunks by default", () => {
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({ enabled: true });
    const audit = handleCouncilChunk({ type: "council_preflight", councilPreflight: { preflightId: "pf-1" } }, a, sink);
    expect(sink.respondToPreflight).toHaveBeenCalledWith("pf-1", true);
    expect(audit).toContain("approve");
  });

  it("rejects preflight when file says preflightApprove: false", () => {
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({
      enabled: false,
      file: { preflightApprove: false },
    });
    handleCouncilChunk({ type: "council_preflight", councilPreflight: { preflightId: "pf-2" } }, a, sink);
    expect(sink.respondToPreflight).toHaveBeenCalledWith("pf-2", false);
  });

  it("replays the 1a8fb4be3bc3 session via a scripted file", () => {
    // Simulates the 3 clarify answers from chat-export-1a8fb4be3bc3.txt
    // plus a typical research-skip "no" + post-debate "continue" + preflight approve.
    const sink = makeSink();
    const a = createCouncilAutoAnswerer({
      enabled: true,
      file: {
        clarify: [
          "Browser extension (Chrome/Brave/Edge compatible)",
          "Google Cloud Translation API (paid, reliable)",
          "Auto-show tooltip/popup immediately on text highlight",
        ],
        // FIFO across all post-debate askcards: research-skip → "no", then post-debate continue
        "post-debate": ["no", "continue"],
      },
    });
    const order: string[] = [];
    const fakeStream: Array<{
      type: string;
      councilQuestion?: CouncilQuestionData;
      councilPreflight?: { preflightId: string };
    }> = [
      { type: "council_question", councilQuestion: q({ phase: "clarify", questionId: "c1" }) },
      { type: "council_question", councilQuestion: q({ phase: "clarify", questionId: "c2" }) },
      { type: "council_question", councilQuestion: q({ phase: "clarify", questionId: "c3" }) },
      // research skip → no scripted answer for "post-debate" yet; --yes default kicks in (option 0 = "no")
      {
        type: "council_question",
        councilQuestion: q({
          phase: "post-debate",
          questionId: "research-skip",
          defaultIndex: 0,
          options: [
            { label: "No — run research", value: "no", kind: "choice" },
            { label: "Yes — skip", value: "yes", kind: "choice" },
          ],
        }),
      },
      { type: "council_preflight", councilPreflight: { preflightId: "pf-1" } },
      // post-debate scripted "continue"
      { type: "council_question", councilQuestion: q({ phase: "post-debate", questionId: "pd-1" }) },
    ];
    for (const chunk of fakeStream) {
      handleCouncilChunk(chunk, a, sink);
    }
    for (const call of sink.respondToQuestion.mock.calls) order.push(call[1]);
    expect(order).toEqual([
      "Browser extension (Chrome/Brave/Edge compatible)",
      "Google Cloud Translation API (paid, reliable)",
      "Auto-show tooltip/popup immediately on text highlight",
      "no",
      "continue",
    ]);
    expect(sink.respondToPreflight).toHaveBeenCalledWith("pf-1", true);
  });
});
