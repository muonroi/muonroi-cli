import { describe, expect, it } from "vitest";
import { detectNoClarifySignal, hasOperationalScope } from "../clarity-gate.js";

// Phase 2 (2026-06-16): the regex ASK gate (shouldAutoPass + canInferOutcome +
// the per-modality scope detectors) was removed — the model now decides every
// clarification. Only two non-gating helpers survive: detectNoClarifySignal
// (explicit user consent) and hasOperationalScope (outcome-label polish).

describe("detectNoClarifySignal()", () => {
  it("detects explicit no-clarify directives (EN)", () => {
    expect(detectNoClarifySignal("just answer, don't ask me anything")).toBe(true);
    expect(detectNoClarifySignal("answer directly without asking")).toBe(true);
    expect(detectNoClarifySignal("no questions please, just do it")).toBe(true);
    expect(detectNoClarifySignal("stop asking and give me the result")).toBe(true);
  });

  it("detects explicit no-clarify directives (VI + transliteration)", () => {
    expect(detectNoClarifySignal("Đừng hỏi lại. Trả lời thẳng 3 câu hỏi.")).toBe(true);
    expect(detectNoClarifySignal("không cần hỏi, trả lời luôn")).toBe(true);
    expect(detectNoClarifySignal("tra loi thang dung hoi")).toBe(true);
  });

  it("does NOT match the explanation idiom 'don't ask me why'", () => {
    expect(detectNoClarifySignal("it just works, don't ask me why")).toBe(false);
    expect(detectNoClarifySignal("explain the auth flow")).toBe(false);
    expect(detectNoClarifySignal("which part of the code should I read?")).toBe(false);
  });
});

describe("hasOperationalScope()", () => {
  it("detects ci/build/test/action keywords", () => {
    expect(hasOperationalScope("fix ci fail")).toBe(true);
    expect(hasOperationalScope("the build is broken")).toBe(true);
    expect(hasOperationalScope("workflow keeps failing")).toBe(true);
    expect(hasOperationalScope("gh check shows red")).toBe(true);
  });
  it("returns false for unrelated prompts", () => {
    expect(hasOperationalScope("refactor login flow")).toBe(false);
    expect(hasOperationalScope("explain hooks")).toBe(false);
  });
});
