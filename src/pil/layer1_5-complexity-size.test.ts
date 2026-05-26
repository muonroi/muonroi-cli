/**
 * src/pil/layer1_5-complexity-size.test.ts
 *
 * Unit tests for Layer 1.5 complexity-size classifier.
 * Pure deterministic heuristic — no LLM, no network.
 *
 * Baseline prompts mirror the 5 Phase-4 baseline sessions captured in
 * `.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md`.
 */

import { describe, expect, it } from "vitest";
import { scoreComplexitySize } from "./layer1_5-complexity-size.js";

describe("scoreComplexitySize — baseline prompts", () => {
  it("[baseline-1] short analyze prompt with single file ref → small", () => {
    const r = scoreComplexitySize({
      rawText: "giải thích đoạn code ở src/index.ts:1403",
      taskType: "analyze",
    });
    expect(r.size).toBe("small");
  });

  it("[baseline-2] short generate prompt with two file refs → small", () => {
    const r = scoreComplexitySize({
      rawText: "đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts",
      taskType: "generate",
    });
    expect(r.size).toBe("small");
  });

  it("[baseline-3] debug prompt (no stack trace) → small or medium", () => {
    const r = scoreComplexitySize({
      rawText: "tìm xem tại sao bash_output_get trả empty khi run_id sai",
      taskType: "debug",
    });
    expect(["small", "medium"]).toContain(r.size);
  });

  it("[baseline-4] feature-add generate prompt → medium", () => {
    const r = scoreComplexitySize({
      rawText: "thêm flag --budget-tokens N, khi total tokens > N thì halt với reason='budget exhausted'",
      taskType: "generate",
    });
    expect(r.size).toBe("medium");
  });

  it("[baseline-5] vague sweeping analyze prompt 'improve test coverage' → large", () => {
    const r = scoreComplexitySize({
      rawText: "improve test coverage",
      taskType: "analyze",
    });
    expect(r.size).toBe("large");
  });
});

describe("scoreComplexitySize — boundary cases", () => {
  it("empty prompt → small (very short ⇒ -2)", () => {
    const r = scoreComplexitySize({ rawText: "", taskType: "general" });
    expect(r.size).toBe("small");
  });

  it("question form (what...) → questionScore=-1 applied", () => {
    const r = scoreComplexitySize({
      rawText: "what does this function do?",
      taskType: "analyze",
    });
    expect(r.features.questionScore).toBe(-1);
    expect(r.size).toBe("small");
  });

  it("refactor keyword alone in medium-length prompt → +2 heavy bump", () => {
    const r = scoreComplexitySize({
      rawText:
        "please refactor the auth module so handlers are extracted into smaller files for clarity and testability",
      taskType: "refactor",
    });
    expect(r.features.heavyScore).toBe(2);
    expect(["medium", "large"]).toContain(r.size);
  });
});

describe("scoreComplexitySize — stack-trace mitigation", () => {
  it("debug prompt with long stack trace counts trace lines as 1 unit toward len", () => {
    const stackTrace = Array.from({ length: 40 }, (_, i) => `    at fn${i} (src/foo.ts:${i}:10)`).join("\n");
    const rawText = `fails at runtime, see trace:\n${stackTrace}`;
    const r = scoreComplexitySize({ rawText, taskType: "debug" });
    // Without mitigation, len would be > 240 ⇒ +2. With mitigation, len is short ⇒ -2.
    expect(r.features.lenScore).toBeLessThanOrEqual(0);
  });
});

describe("scoreComplexitySize — output shape", () => {
  it("returns deterministic object with size, score, features", () => {
    const a = scoreComplexitySize({ rawText: "foo", taskType: "general" });
    const b = scoreComplexitySize({ rawText: "foo", taskType: "general" });
    expect(a).toEqual(b);
    expect(typeof a.score).toBe("number");
    expect(["small", "medium", "large"]).toContain(a.size);
    expect(a.features).toBeDefined();
  });
});

describe("scoreComplexitySize — null/undefined defaults", () => {
  it("missing rawText defaults to empty string", () => {
    const r = scoreComplexitySize({} as any);
    expect(r.size).toBe("small");
    expect(r.features.len).toBe(0);
  });

  it("missing taskType defaults to 'general'", () => {
    const r = scoreComplexitySize({ rawText: "some text", taskType: undefined } as any);
    expect(r.size).toBe("small");
  });
});

describe("scoreComplexitySize — path score edges", () => {
  it("pathCount === 2 gives neutral pathScore 0", () => {
    const r = scoreComplexitySize({
      rawText: "update foo.ts and bar.py",
      taskType: "generate",
    });
    expect(r.features.pathCount).toBe(2);
    expect(r.features.pathScore).toBe(0);
  });

  it("pathCount === 0 gives neutral pathScore 0 when no sweep word", () => {
    const r = scoreComplexitySize({
      rawText: "fix typo",
      taskType: "general",
    });
    expect(r.features.pathCount).toBe(0);
    expect(r.features.pathScore).toBe(0);
  });

  it("pathCount >= 3 gives pathScore 2", () => {
    const r = scoreComplexitySize({
      rawText: "fix src/a.ts, src/b.ts, src/c.ts",
      taskType: "generate",
    });
    expect(r.features.pathCount).toBe(3);
    expect(r.features.pathScore).toBe(2);
  });

  it("countDistinctPaths deduplicates case-insensitive matches", () => {
    const r = scoreComplexitySize({
      rawText: "update SRC/a.ts AND src/A.ts",
      taskType: "generate",
    });
    expect(r.features.pathCount).toBe(1);
  });

  it("non-code extensions are not counted as path tokens", () => {
    const r = scoreComplexitySize({
      rawText: "check file.txt and photo.jpg",
      taskType: "general",
    });
    expect(r.features.pathCount).toBe(0);
  });
});

describe("scoreComplexitySize — vagueness amplifier", () => {
  it("sweep word with zero path anchors → amplifier 4", () => {
    const r = scoreComplexitySize({
      rawText: "improve things around here",
      taskType: "general",
    });
    expect(r.features.sweepCount).toBeGreaterThan(0);
    expect(r.features.pathCount).toBe(0);
    expect(r.features.vaguenessAmplifier).toBe(4);
  });

  it("sweep word with at least one path anchor → amplifier 0", () => {
    const r = scoreComplexitySize({
      rawText: "improve test coverage in src/pil/",
      taskType: "general",
    });
    expect(r.features.sweepCount).toBeGreaterThan(0);
    expect(r.features.pathCount).toBeGreaterThanOrEqual(1);
    expect(r.features.vaguenessAmplifier).toBe(0);
  });
});

describe("scoreComplexitySize — length thresholds", () => {
  it("exactly 80 chars → lenScore 0 (not small)", () => {
    const r = scoreComplexitySize({ rawText: "a".repeat(80), taskType: "general" });
    expect(r.features.lenScore).toBe(0);
    expect(r.features.len).toBe(80);
  });

  it("exactly 241 chars → lenScore 2", () => {
    const r = scoreComplexitySize({ rawText: "a".repeat(241), taskType: "general" });
    expect(r.features.lenScore).toBe(2);
    expect(r.features.len).toBe(241);
  });

  it("79 chars → lenScore -2", () => {
    const r = scoreComplexitySize({ rawText: "a".repeat(79), taskType: "general" });
    expect(r.features.lenScore).toBe(-2);
  });
});

describe("scoreComplexitySize — size bucket boundaries", () => {
  it("score <= -1 → small", () => {
    const r = scoreComplexitySize({ rawText: "hi", taskType: "general" });
    // len=-2, pathScore=-1 (1 path match 'hi'? no — no path), score = -2
    expect(r.score).toBeLessThanOrEqual(-1);
    expect(r.size).toBe("small");
  });

  it("score 0..3 → medium", () => {
    // 80 chars → lenScore 0, 1 file path → pathScore -1, no sweep → score = -1 + 0 = -1? Too low.
    // Instead: no sweep, no path, exactly 80 chars → score = 0 → medium
    const r = scoreComplexitySize({
      rawText: "b".repeat(80),
      taskType: "general",
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(3);
    expect(r.size).toBe("medium");
  });

  it("score >= 4 → large", () => {
    // vagueness amplifier 4 + sweep +2 => score >= 4
    const r = scoreComplexitySize({
      rawText: "improve everything all across the entire codebase",
      taskType: "general",
    });
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.size).toBe("large");
  });
});

describe("scoreComplexitySize — imperative detection", () => {
  it("imperative start verb is flagged", () => {
    const r = scoreComplexitySize({
      rawText: "add a new endpoint for user profile",
      taskType: "generate",
    });
    expect(r.features.isImperative).toBe(true);
  });

  it("non-imperative start is not flagged", () => {
    const r = scoreComplexitySize({
      rawText: "the system should have an endpoint",
      taskType: "analyze",
    });
    expect(r.features.isImperative).toBe(false);
  });
});

describe("scoreComplexitySize — stack trace (non-debug)", () => {
  it("non-debug task with stack trace does NOT get mitigation", () => {
    const stackTrace = Array.from({ length: 50 }, (_, i) => `    at fn${i} (foo.ts:${i}:10)`).join("\n");
    const rawText = `Error:\n${stackTrace}`;
    const r = scoreComplexitySize({ rawText, taskType: "generate" });
    // Without mitigation len > 240 => lenScore 2
    expect(r.features.lenScore).toBe(2);
  });
});

describe("scoreComplexitySize — debug without stack trace", () => {
  it("debug prompt without stack trace does not get mitigation (len is normal)", () => {
    const r = scoreComplexitySize({ rawText: "why is this slow", taskType: "debug" });
    expect(r.features.len).toBe("why is this slow".length);
    expect(r.size).toBe("small");
  });
});

describe("scoreComplexitySize — heavy score composition", () => {
  it("refactor + sweep + 3+ paths → large", () => {
    const r = scoreComplexitySize({
      rawText: "refactor all the things in src/a.ts, src/b.ts, src/c.ts, src/d.ts",
      taskType: "refactor",
    });
    expect(r.features.heavyScore).toBe(2);
    expect(r.features.pathCount).toBeGreaterThanOrEqual(3);
    expect(r.size).toBe("large");
  });
});
