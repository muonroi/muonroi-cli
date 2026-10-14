import { afterEach, describe, expect, it } from "vitest";
import {
  appendNoticeToFinalMessages,
  buildOutputLimitContinuationPrompt,
  buildOutputLimitNotice,
  DEFAULT_OUTPUT_LIMIT_CONTINUATIONS,
  decideOutputLimitAction,
  getOutputLimitContinuationCap,
  resumeTail,
} from "../output-limit-continuation.js";

describe("decideOutputLimitAction", () => {
  it("continues a length stop while under the cap", () => {
    expect(
      decideOutputLimitAction({ finishReason: "length", answeredElsewhere: false, continuations: 0, cap: 2 }),
    ).toBe("continue");
  });
  it("falls back to the notice once the cap is spent", () => {
    expect(
      decideOutputLimitAction({ finishReason: "length", answeredElsewhere: false, continuations: 2, cap: 2 }),
    ).toBe("notice");
    expect(
      decideOutputLimitAction({ finishReason: "length", answeredElsewhere: false, continuations: 0, cap: 0 }),
    ).toBe("notice");
  });
  it("ignores every other finish reason", () => {
    for (const finishReason of ["stop", "tool-calls", "error", "other", null, undefined]) {
      expect(decideOutputLimitAction({ finishReason, answeredElsewhere: false, continuations: 0, cap: 2 })).toBe(
        "none",
      );
    }
  });
  it("leaves an answer that came from a response tool or the F6 synthesis alone", () => {
    expect(decideOutputLimitAction({ finishReason: "length", answeredElsewhere: true, continuations: 0, cap: 2 })).toBe(
      "none",
    );
  });
});

describe("getOutputLimitContinuationCap", () => {
  const KEY = "MUONROI_OUTPUT_LIMIT_CONTINUATIONS";
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it("defaults when unset or invalid", () => {
    delete process.env[KEY];
    expect(getOutputLimitContinuationCap()).toBe(DEFAULT_OUTPUT_LIMIT_CONTINUATIONS);
    process.env[KEY] = "nope";
    expect(getOutputLimitContinuationCap()).toBe(DEFAULT_OUTPUT_LIMIT_CONTINUATIONS);
    process.env[KEY] = "-1";
    expect(getOutputLimitContinuationCap()).toBe(DEFAULT_OUTPUT_LIMIT_CONTINUATIONS);
  });
  it("accepts 0 to disable auto-continue and clamps large values", () => {
    process.env[KEY] = "0";
    expect(getOutputLimitContinuationCap()).toBe(0);
    process.env[KEY] = "99";
    expect(getOutputLimitContinuationCap()).toBe(10);
  });
});

describe("resumeTail", () => {
  it("returns short text whole", () => {
    expect(resumeTail("vẫn 429 sau 2.6–")).toBe("vẫn 429 sau 2.6–");
  });
  it("keeps the last N code points without splitting a surrogate pair", () => {
    const text = `${"a".repeat(10)}😀b`;
    expect(resumeTail(text, 2)).toBe("😀b");
    expect(Array.from(resumeTail("x".repeat(500))).length).toBe(240);
  });
});

describe("buildOutputLimitContinuationPrompt", () => {
  it("quotes the cut tail so the model resumes at the exact spot", () => {
    const prompt = buildOutputLimitContinuationPrompt("…không output, vẫn 429 sau 2.6–");
    expect(prompt).toContain("output-token limit");
    expect(prompt).toContain("vẫn 429 sau 2.6–");
    expect(prompt).toContain("do not repeat");
  });
  it("still asks to continue when nothing visible was emitted", () => {
    expect(buildOutputLimitContinuationPrompt("")).toContain("Output ONLY the remaining part");
  });
});

describe("buildOutputLimitNotice", () => {
  it("names the limit and the continuations already spent", () => {
    const notice = buildOutputLimitNotice({ maxOutputTokens: 64000, continuations: 2 });
    expect(notice).toContain("64,000 tokens");
    expect(notice).toContain("after 2 automatic continuations");
    expect(notice).toContain('"continue"');
  });
  it("omits an unknown limit", () => {
    const notice = buildOutputLimitNotice({ continuations: 0 });
    expect(notice).not.toContain("tokens)");
    expect(notice).not.toContain("automatic continuation");
  });
});

describe("appendNoticeToFinalMessages", () => {
  it("appends to a string assistant message", () => {
    const out = appendNoticeToFinalMessages([{ role: "assistant", content: "cut" }], " [N]");
    expect(out).toEqual([{ role: "assistant", content: "cut [N]" }]);
  });
  it("appends to the last text part of a parts assistant message", () => {
    const out = appendNoticeToFinalMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "cut" },
          ],
        },
      ],
      " [N]",
    );
    expect(out[0]!.content).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "cut [N]" },
    ]);
  });
  it("adds a separate assistant message when the turn did not end on assistant text", () => {
    const out = appendNoticeToFinalMessages([{ role: "tool", content: [] }], "\n\n[N]");
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: "assistant", content: "[N]" });
  });
});
