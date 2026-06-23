import { describe, expect, it } from "vitest";
import type { ModelCard, ProjectContext } from "../discovery-types.js";
import { modelCardToQuestion, resolveGapsNonInteractive } from "../layer16-clarity.js";

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

describe("modelCardToQuestion()", () => {
  it("maps ModelCard to CouncilQuestionData with pil-interview phase", () => {
    const card: ModelCard = {
      question: "What outcome?",
      context: "This changes how we debug",
      options: [
        { label: "Error disappears", kind: "choice" },
        { label: "Custom fix", kind: "freetext" },
      ],
      defaultIndex: 0,
    };
    const q = modelCardToQuestion(card, "q-1");
    expect(q.phase).toBe("pil-interview");
    expect(q.questionId).toBe("q-1");
    expect(q.options).toBeDefined();
    expect(q.options).toHaveLength(2);
    expect(q.options![0]!.isCancel).toBeUndefined();
    expect(q.options![0]!.isAdjust).toBeUndefined();
  });

  it("preserves isCancel and isAdjust flags from model card options", () => {
    const card: ModelCard = {
      question: "Proceed?",
      options: [
        { label: "Looks good, go ahead", kind: "choice" },
        { label: "Cancel this", kind: "choice", isCancel: true },
        { label: "Let me clarify", kind: "choice", isAdjust: true },
      ],
      defaultIndex: 0,
    };
    const q = modelCardToQuestion(card, "q-2");
    expect(q.options![1]!.isCancel).toBe(true);
    expect(q.options![2]!.isAdjust).toBe(true);
  });
});

describe("resolveGapsNonInteractive()", () => {
  it("fills gaps with default options from model cards", () => {
    const cards: ModelCard[] = [
      {
        question: "What outcome?",
        options: [
          { label: "Error resolved", kind: "choice" },
          { label: "Not sure", kind: "freetext" },
        ],
        defaultIndex: 0,
      },
    ];
    const resolved = resolveGapsNonInteractive(cards, EMPTY_PROJECT, "fix auth");
    expect(resolved.outcome).toContain("Error resolved");
  });

  it("falls back to raw-derived outcome when model cards are empty", () => {
    const resolved = resolveGapsNonInteractive([], EMPTY_PROJECT, "fix the login bug");
    expect(resolved.outcome).toBeTruthy();
    expect(resolved.scope.length).toBeGreaterThan(0);
  });
});
