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
