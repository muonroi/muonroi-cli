import { describe, expect, it } from "vitest";
import type { ClarityGap, ProjectContext } from "../discovery-types.js";
import { buildInterviewQuestion, resolveGapsNonInteractive } from "../layer16-clarity.js";

// Phase 2 (2026-06-16): detectClarityGaps + its keyword option-builders were
// removed (the model now generates every clarification). The surviving helpers
// — buildInterviewQuestion (render) and resolveGapsNonInteractive (headless
// default-answer resolution) — are exercised here with model-shaped gaps.

const EMPTY_PROJECT: ProjectContext = {
  language: "typescript",
  framework: null,
  packageManager: null,
  domain: null,
  boundedContexts: [
    { path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: ["login", "logout"] },
    { path: "src/billing/", name: "billing", entryFiles: [], exportedSymbols: [] },
  ],
  eePatterns: [],
  relevantModules: [{ path: "src/auth/", relevance: "named in prompt", exists: true }],
  scannedAt: Date.now(),
  cwd: "/proj",
};

describe("buildInterviewQuestion()", () => {
  it("builds a CouncilQuestionData with pil-interview phase", () => {
    const gap: ClarityGap = {
      dimension: "outcome",
      description: "no outcome",
      suggestedQuestion: "What outcome?",
      options: ["test passes", "no error"],
      defaultIndex: 0,
    };
    const q = buildInterviewQuestion(gap, "q-1");
    expect(q.phase).toBe("pil-interview");
    expect(q.questionId).toBe("q-1");
    expect(q.options).toBeDefined();
    expect(q.options!.some((o) => o.kind === "freetext")).toBe(true);
  });

  it("surfaces the model's reason (gap.description) as the askcard context", () => {
    const gap: ClarityGap = {
      dimension: "outcome",
      description: "answering this changes whether we add OAuth or just API keys",
      suggestedQuestion: "Which auth method?",
      options: ["OAuth", "API keys"],
      defaultIndex: 0,
    };
    const q = buildInterviewQuestion(gap, "q-2");
    expect(q.context).toBe("answering this changes whether we add OAuth or just API keys");
  });
});

describe("resolveGapsNonInteractive()", () => {
  it("fills gaps with best-effort defaults from the model options + project context", () => {
    const gaps: ClarityGap[] = [
      {
        dimension: "outcome",
        description: "Model-generated clarification #1",
        suggestedQuestion: "What outcome do you expect?",
        options: ["Error resolved", "Other (type free answer)"],
        defaultIndex: 0,
      },
    ];
    const resolved = resolveGapsNonInteractive(gaps, EMPTY_PROJECT, "fix auth");
    expect(resolved.outcome).toBe("Error resolved");
    expect(resolved.scope.length).toBeGreaterThan(0);
  });

  it("falls back to the raw-derived outcome when there is no outcome gap", () => {
    const resolved = resolveGapsNonInteractive([], EMPTY_PROJECT, "fix the login bug");
    expect(resolved.outcome).toBeTruthy();
    expect(resolved.scope.length).toBeGreaterThan(0);
  });
});
