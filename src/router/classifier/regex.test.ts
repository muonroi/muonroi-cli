import { describe, expect, it } from "vitest";
import { matchRegex } from "./regex.js";

describe("matchRegex", () => {
  it('classifies "create file foo.ts with hello world" with confidence >= 0.55', () => {
    const result = matchRegex("create file foo.ts with hello world");
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.reason).toMatch(/^regex:/);
  });

  it('classifies "hi how are you" with confidence < 0.55', () => {
    const result = matchRegex("hi how are you");
    expect(result.confidence).toBeLessThan(0.55);
    expect(result.reason).toBe("regex:no-match");
  });

  describe("seed intents (>= 7 patterns at >= 0.55 confidence)", () => {
    const seeds = [
      { prompt: "create a file called app.ts", intent: "create-file" },
      { prompt: "edit the main.ts file to fix the bug", intent: "edit" },
      { prompt: "run the test command", intent: "run-command" },
      { prompt: "explain what this code does", intent: "explain" },
      { prompt: "refactor the auth module", intent: "refactor" },
      { prompt: "search for the function declaration", intent: "search" },
      { prompt: "install package express", intent: "install" },
    ];

    for (const { prompt, intent } of seeds) {
      it(`matches "${prompt}" as regex:${intent} with >= 0.55`, () => {
        const result = matchRegex(prompt);
        expect(result.confidence).toBeGreaterThanOrEqual(0.55);
        expect(result.reason).toBe(`regex:${intent}`);
      });
    }
  });

  it('returns tier "hot" for high confidence matches', () => {
    const result = matchRegex("create a file called foo.ts");
    expect(result.tier).toBe("hot");
  });

  it('returns tier "abstain" for no-match', () => {
    const result = matchRegex("hi how are you");
    expect(result.tier).toBe("abstain");
  });
});
