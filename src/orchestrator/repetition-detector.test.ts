import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _internals,
  _resetForTests,
  buildRepetitionReminder,
  extractLeadingPhrase,
  recordAssistantBurst,
  shouldInjectRepetitionReminder,
} from "./repetition-detector.js";

describe("extractLeadingPhrase", () => {
  it("returns lowercased first N words stripped of punctuation", () => {
    expect(extractLeadingPhrase("YES still on scope. Commit pushed.")).toBe("yes still on scope");
  });

  it("returns null when fewer than N words", () => {
    expect(extractLeadingPhrase("hi there")).toBeNull();
    expect(extractLeadingPhrase("")).toBeNull();
    expect(extractLeadingPhrase(null)).toBeNull();
    expect(extractLeadingPhrase(undefined)).toBeNull();
  });

  it("strips code fences before counting words", () => {
    const text = "```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\nYES still on scope here we go";
    expect(extractLeadingPhrase(text)).toBe("yes still on scope");
  });

  it("handles Vietnamese accents", () => {
    expect(extractLeadingPhrase("Tiếp tục theo dõi CI rồi")).toBe("tiếp tục theo dõi");
  });
});

describe("recordAssistantBurst + shouldInjectRepetitionReminder", () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it("counts consecutive bursts that share the same opening phrase", () => {
    expect(recordAssistantBurst("s1", "YES still on scope. Doing X.")).toBe(1);
    expect(recordAssistantBurst("s1", "YES still on scope. Doing Y.")).toBe(2);
    expect(recordAssistantBurst("s1", "YES still on scope. Doing Z.")).toBe(3);
  });

  it("resets the run when the opening phrase changes", () => {
    recordAssistantBurst("s1", "YES still on scope. A");
    recordAssistantBurst("s1", "YES still on scope. B");
    expect(recordAssistantBurst("s1", "Switching approach now to a totally different plan")).toBe(1);
  });

  it("preserves the run when an interleaved burst has no phrase (tool-only step)", () => {
    recordAssistantBurst("s1", "YES still on scope. First call");
    recordAssistantBurst("s1", "YES still on scope. Second call");
    // Non-text burst — counter should not reset.
    expect(recordAssistantBurst("s1", "")).toBe(2);
    expect(recordAssistantBurst("s1", "YES still on scope. Third call")).toBe(3);
  });

  it("isolates state per session", () => {
    recordAssistantBurst("a", "YES still on scope. one");
    recordAssistantBurst("a", "YES still on scope. two");
    recordAssistantBurst("b", "Totally different opening phrase here");
    expect(recordAssistantBurst("a", "YES still on scope. three")).toBe(3);
    expect(recordAssistantBurst("b", "Totally different opening phrase here")).toBe(2);
  });

  it("returns 1 for null/empty sessionId", () => {
    expect(recordAssistantBurst(null, "YES still on scope. x")).toBe(1);
    expect(recordAssistantBurst("", "YES still on scope. x")).toBe(1);
    expect(recordAssistantBurst(undefined, "YES still on scope. x")).toBe(1);
  });

  it("trigger fires once at runLength >= TRIGGER_RUN_LENGTH", () => {
    recordAssistantBurst("s1", "YES still on scope. one");
    recordAssistantBurst("s1", "YES still on scope. two");
    expect(shouldInjectRepetitionReminder("s1")).toBe(false);
    recordAssistantBurst("s1", "YES still on scope. three");
    expect(shouldInjectRepetitionReminder("s1")).toBe(true);
  });

  it("trigger does not re-fire while the run continues", () => {
    recordAssistantBurst("s1", "YES still on scope. one");
    recordAssistantBurst("s1", "YES still on scope. two");
    recordAssistantBurst("s1", "YES still on scope. three");
    expect(shouldInjectRepetitionReminder("s1")).toBe(true);
    recordAssistantBurst("s1", "YES still on scope. four");
    expect(shouldInjectRepetitionReminder("s1")).toBe(false);
    recordAssistantBurst("s1", "YES still on scope. five");
    expect(shouldInjectRepetitionReminder("s1")).toBe(false);
  });

  it("trigger re-arms when a new run begins", () => {
    recordAssistantBurst("s1", "YES still on scope. one");
    recordAssistantBurst("s1", "YES still on scope. two");
    recordAssistantBurst("s1", "YES still on scope. three");
    shouldInjectRepetitionReminder("s1"); // mark fired

    // New phrase — counter resets, fire flag clears.
    recordAssistantBurst("s1", "Switching approach now to a totally different plan");
    recordAssistantBurst("s1", "Switching approach now to step two");
    recordAssistantBurst("s1", "Switching approach now to step three");
    expect(shouldInjectRepetitionReminder("s1")).toBe(true);
  });

  it("trigger no-op for unknown / null session", () => {
    expect(shouldInjectRepetitionReminder(null)).toBe(false);
    expect(shouldInjectRepetitionReminder("never-recorded")).toBe(false);
  });
});

describe("buildRepetitionReminder", () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it("includes the perseveration phrase and runLength", () => {
    recordAssistantBurst("s1", "YES still on scope. one");
    recordAssistantBurst("s1", "YES still on scope. two");
    recordAssistantBurst("s1", "YES still on scope. three");
    const msg = buildRepetitionReminder("s1");
    expect(msg).toContain("self-repetition detected");
    expect(msg).toContain("yes still on scope");
    expect(msg).toContain("3");
  });

  it("constants are stable for callers", () => {
    expect(_internals.PHRASE_WORD_COUNT).toBe(4);
    expect(_internals.TRIGGER_RUN_LENGTH).toBe(3);
  });
});
