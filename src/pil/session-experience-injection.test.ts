/**
 * Felt-experience routing: a "cảm nhận trong CLI" / "are you blind?" question
 * gets the live session-experience snapshot injected so the agent answers from
 * lived data, while a plain "evaluate the CLI" prompt does NOT.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSessionExperienceForTests,
  recordCompaction,
  recordElision,
} from "../orchestrator/session-experience.js";
import { injectSessionExperience, isSelfExperiencePrompt } from "./session-experience-injection.js";
import type { PipelineContext } from "./types.js";

function baseCtx(raw: string): PipelineContext {
  return {
    raw,
    enriched: raw,
    taskType: "analyze",
    domain: null,
    confidence: 1,
    outputStyle: null,
    tokenBudget: 8000,
    metrics: null,
    layers: [],
  };
}

describe("isSelfExperiencePrompt", () => {
  it("matches first-person experience / blindness / struggle questions (VI + EN)", () => {
    for (const p of [
      "cảm nhận trong cli thế nào",
      "bạn có bị mù context hay cảm thấy có vấn đề gì khi làm việc trong các turn này không",
      "how do you feel working in this session",
      "did you struggle with anything this session",
      "are you blind to earlier context?",
      "bạn có gặp khó khăn gì không",
    ]) {
      expect(isSelfExperiencePrompt(p)).toBe(true);
    }
  });

  it("does NOT match plain evaluate/improve-the-CLI prompts", () => {
    for (const p of [
      "đánh giá agent bên trong cli và đề xuất cải thiện",
      "phân tích pipeline PIL",
      "improve the compaction subsystem",
      "review the council code",
    ]) {
      expect(isSelfExperiencePrompt(p)).toBe(false);
    }
  });
});

describe("injectSessionExperience", () => {
  afterEach(() => __resetSessionExperienceForTests());

  it("injects an intact-context snapshot on a fresh session and steers away from source-reading", () => {
    const out = injectSessionExperience(baseCtx("bạn có bị mù context không trong session này"));
    expect(out.enriched).toContain("[session experience —");
    expect(out.enriched).toContain("context is intact this session");
    expect(out.enriched).toMatch(/not by reading the CLI source/i);
    expect(out.layers.at(-1)).toMatchObject({ name: "session-experience", applied: true });
  });

  it("reflects real counters when the session actually compacted/elided", () => {
    recordCompaction(5);
    recordElision("call_z", "read_file", 7000, 5);
    const out = injectSessionExperience(baseCtx("cảm nhận của bạn trong cli ra sao"));
    expect(out.enriched).toContain("fired 1x");
    expect(out.enriched).toContain("Tool outputs elided: 1");
  });

  it("is a marker-recorded no-op for non-experience prompts", () => {
    const out = injectSessionExperience(baseCtx("đánh giá tổng thể CLI và cải thiện"));
    expect(out.enriched).not.toContain("[session experience —");
    expect(out.layers.at(-1)).toMatchObject({
      name: "session-experience",
      applied: false,
      delta: "not-self-experience",
    });
  });

  it("is idempotent — does not double-inject", () => {
    const once = injectSessionExperience(baseCtx("cảm nhận trong cli"));
    const twice = injectSessionExperience(once);
    const occurrences = twice.enriched.split("[session experience —").length - 1;
    expect(occurrences).toBe(1);
    expect(twice.layers.at(-1)).toMatchObject({ applied: false, delta: "already-injected" });
  });
});
