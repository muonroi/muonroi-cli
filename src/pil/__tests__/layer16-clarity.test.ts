import { describe, expect, it } from "vitest";
import type { ProjectContext } from "../discovery-types.js";
import { buildInterviewQuestion, detectClarityGaps, resolveGapsNonInteractive } from "../layer16-clarity.js";

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
  relevantModules: [],
  scannedAt: Date.now(),
  cwd: "/proj",
};

describe("detectClarityGaps()", () => {
  it("detects outcome gap for vague non-debug prompt", () => {
    // PIL-L6 fix — debug now joins the autofill set, so vague debug prompts
    // ("fix auth") no longer trigger an outcome question. Use a generate
    // prompt instead to still cover the gap-detection path.
    const gaps = detectClarityGaps("build something", "generate", 0.7, EMPTY_PROJECT);
    const outcomeGap = gaps.find((g) => g.dimension === "outcome");
    expect(outcomeGap).toBeDefined();
  });

  it("does NOT detect outcome gap for vague debug prompt (autofilled)", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const outcomeGap = gaps.find((g) => g.dimension === "outcome");
    expect(outcomeGap).toBeUndefined();
  });

  it("does NOT detect an outcome gap for a vague general prompt (B2 intent-swallow guard)", () => {
    // B2 — a `general` prompt's only outcome options are tautological
    // ("Task completed" / "Issue resolved"). Asking them lets the default
    // answer overwrite the user's real request, so the intent collapses to
    // "general: Task completed" and the original prompt is lost. Skip the
    // askcard so the outcome falls back to the raw request downstream.
    const gaps = detectClarityGaps("the project feels messy", "general", 0.7, EMPTY_PROJECT);
    const outcomeGap = gaps.find((g) => g.dimension === "outcome");
    expect(outcomeGap).toBeUndefined();
  });

  it("detects scope gap when no file reference", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const scopeGap = gaps.find((g) => g.dimension === "scope");
    expect(scopeGap).toBeDefined();
  });

  it("returns no gaps for specific prompt", () => {
    const gaps = detectClarityGaps("fix TypeError in src/auth/login.ts:42", "debug", 0.9, EMPTY_PROJECT);
    expect(gaps).toHaveLength(0);
  });

  it("scope options include matching bounded contexts", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const scopeGap = gaps.find((g) => g.dimension === "scope");
    expect(scopeGap?.options.some((o) => o.includes("auth"))).toBe(true);
  });

  it("does NOT detect a scope gap for a general prompt with no codebase signal (B2-symmetric scope guard)", () => {
    // Live drive (session 8a87aa060c6a): the pure non-codebase prompt "Reply
    // with exactly one word: PONG" fired the scope askcard "Which part of the
    // codebase should this target?" because countFileReferences /
    // hasExplicitScope / hasOperationalScope were all empty — the detector
    // assumes every prompt is a codebase task. A general/unclassified prompt
    // has no codebase dimension to scope, so the question is nonsensical (and
    // its acceptance card is downstream noise). Skip it, symmetric to the B2
    // outcome guard; scope falls back to project-root downstream.
    const gaps = detectClarityGaps("Reply with exactly one word: PONG", "general", 0.6, EMPTY_PROJECT);
    expect(gaps.find((g) => g.dimension === "scope")).toBeUndefined();
    // The only candidate gap was scope → general prompt now yields zero gaps,
    // so discovery never marks interviewed=true and shows no acceptance card.
    expect(gaps).toHaveLength(0);
  });

  it("STILL detects a scope gap for a classified (non-general) task with no file reference", () => {
    // Guard must stay narrow: a real code task that simply omitted a path still
    // benefits from the scope-narrowing askcard. Only general/null is skipped.
    const gaps = detectClarityGaps("implement the search feature", "generate", 0.7, EMPTY_PROJECT);
    expect(gaps.find((g) => g.dimension === "scope")).toBeDefined();
  });

  it("does NOT detect a scope gap for an image-analysis prompt (image is the scope)", () => {
    // Live drive (PR#34 probe): "Take a screenshot of the homepage and analyze
    // the diagram.png image to describe its layout" fired the codebase-scope
    // askcard "Which part of the codebase should this target?" — nonsensical for
    // an image-analysis task. The image (screenshot / diagram.png) IS the scope,
    // symmetric to how operational (CI/build) prompts are scoped to the pipeline.
    const gaps = detectClarityGaps(
      "Take a screenshot of the homepage and analyze the diagram.png image to describe its layout",
      "analyze",
      0.7,
      EMPTY_PROJECT,
    );
    expect(gaps.find((g) => g.dimension === "scope")).toBeUndefined();
    // analyze autofills outcome, so with scope suppressed there are zero gaps →
    // no interview, no acceptance card.
    expect(gaps).toHaveLength(0);
  });

  it("STILL detects a scope gap for a code task that mentions an ambiguous non-image word", () => {
    // Narrowness guard: image-scope suppression must not swallow real codebase
    // tasks. "add a logo to the header" carries no concrete image signal (no
    // file extension / screenshot / photo), so the scope askcard stays.
    const gaps = detectClarityGaps("add a logo to the header", "generate", 0.7, EMPTY_PROJECT);
    expect(gaps.find((g) => g.dimension === "scope")).toBeDefined();
  });

  it("does NOT detect a scope gap for a web-search / external-info prompt", () => {
    // Live drive (tavily probe, session d7a45a2dba30): "search the web for the
    // latest vitest release notes" classified taskType=analyze fired the
    // codebase-scope askcard and recorded a wrong scope ("src/mcp"). A
    // web-search task is scoped to the web, not the codebase — symmetric to the
    // image-scope and operational-scope guards.
    const gaps = detectClarityGaps("search the web for the latest vitest release notes", "analyze", 0.7, EMPTY_PROJECT);
    expect(gaps.find((g) => g.dimension === "scope")).toBeUndefined();
    expect(gaps).toHaveLength(0);
  });
});

describe("buildInterviewQuestion()", () => {
  it("builds a CouncilQuestionData with pil-interview phase", () => {
    const gap = {
      dimension: "outcome" as const,
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
});

describe("resolveGapsNonInteractive()", () => {
  it("fills gaps with best-effort from project context", () => {
    const gaps = detectClarityGaps("fix auth", "debug", 0.7, EMPTY_PROJECT);
    const resolved = resolveGapsNonInteractive(gaps, EMPTY_PROJECT, "fix auth");
    expect(resolved.outcome).toBeTruthy();
    expect(resolved.scope.length).toBeGreaterThan(0);
  });
});
