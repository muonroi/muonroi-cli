import { describe, expect, it } from "vitest";
import type { ClarifiedIntent, FeasibilityResult } from "../discovery-types.js";
import { buildAcceptanceCard, buildAcceptanceQuestion } from "../layer18-acceptance.js";

describe("buildAcceptanceCard()", () => {
  it("builds card with intent, outcome, scope, and warnings", () => {
    const intent: ClarifiedIntent = { outcome: "error gone", scope: ["src/auth/jwt.ts"], constraints: [], gaps: [] };
    const feasibility: FeasibilityResult = {
      viable: true,
      warnings: ["oauth.ts also handles tokens"],
      adjustedScope: ["src/auth/jwt.ts"],
    };
    const card = buildAcceptanceCard("Fix JWT validation returning 401", intent, feasibility);
    expect(card.intentStatement).toBe("Fix JWT validation returning 401");
    expect(card.outcome).toBe("error gone");
    expect(card.scope).toEqual(["src/auth/jwt.ts"]);
    expect(card.warnings).toEqual(["oauth.ts also handles tokens"]);
  });
});

describe("buildAcceptanceQuestion()", () => {
  it("builds a CouncilQuestionData with pil-acceptance phase", () => {
    const card = { intentStatement: "Fix auth", outcome: "done", scope: ["src/auth/"], warnings: [] };
    const q = buildAcceptanceQuestion(card, "acc-1");
    expect(q.phase).toBe("pil-acceptance");
    expect(q.questionId).toBe("acc-1");
    expect(q.options).toHaveLength(3);
    expect(q.options![0]!.label).toBe("Accept");
    expect(q.options![1]!.label).toBe("Adjust");
    expect(q.options![2]!.label).toBe("Cancel");
    expect(q.defaultIndex).toBe(0);
  });

  it("includes warnings in context when present", () => {
    const card = { intentStatement: "Fix auth", outcome: "done", scope: ["src/auth/"], warnings: ["risk: oauth.ts"] };
    const q = buildAcceptanceQuestion(card, "acc-2");
    expect(q.context).toContain("risk: oauth.ts");
  });

  // Default flips to "Adjust" only for BLOCKING warnings (e.g. infeasibility).
  it("defaults to Adjust (index 1) when warning is blocking", () => {
    const card = {
      intentStatement: "Fix auth",
      outcome: "done",
      scope: ["src/"],
      warnings: ["infeasible: file does not exist"],
    };
    const q = buildAcceptanceQuestion(card, "acc-3");
    expect(q.defaultIndex).toBe(1);
  });

  it("defaults to Accept (index 0) when no warnings", () => {
    const card = { intentStatement: "Fix auth", outcome: "done", scope: ["src/"], warnings: [] };
    const q = buildAcceptanceQuestion(card, "acc-4");
    expect(q.defaultIndex).toBe(0);
  });

  // Fix #7 — informational mismatch warning should NOT flip default to Adjust.
  // Evidence: session 1f29e238 ("Can you fix it?" follow-up) — the intent
  // mismatch detector emitted "Detected debug/bug-fix signals..." which is
  // informational; forcing Adjust looped PIL through another interview round.
  it("defaults to Accept when only warning is intent-mismatch (informational)", () => {
    const card = {
      intentStatement: "debug: Complete: Can you fix it?",
      outcome: "done",
      scope: ["src/"],
      warnings: ['Detected debug/bug-fix signals in your prompt ("fail") but intent reframed as "..."'],
    };
    const q = buildAcceptanceQuestion(card, "acc-5");
    expect(q.defaultIndex).toBe(0);
  });

  it("defaults to Adjust when mix of informational + blocking warnings", () => {
    const card = {
      intentStatement: "Fix auth",
      outcome: "done",
      scope: ["src/"],
      warnings: ["Detected debug signals — Verify before accepting", "infeasible: file does not exist"],
    };
    const q = buildAcceptanceQuestion(card, "acc-6");
    expect(q.defaultIndex).toBe(1);
  });
});

describe("buildAcceptanceCard() intent-mismatch detection — PIL-L6", () => {
  const baseFeas: FeasibilityResult = { viable: true, warnings: [], adjustedScope: [] };

  it("flags warning when raw has debug signals but intent is non-debug", () => {
    const intent: ClarifiedIntent = { outcome: "Feature implemented", scope: ["project"], constraints: [], gaps: [] };
    const card = buildAcceptanceCard(
      "generate: Feature implemented and working",
      intent,
      baseFeas,
      "ci action fail dùng gh check và fix cho t",
    );
    expect(card.warnings.length).toBeGreaterThan(0);
    expect(card.warnings[0]).toMatch(/debug.*signals|Verify before accepting/i);
  });

  it("no mismatch when intent statement matches debug signal", () => {
    const intent: ClarifiedIntent = { outcome: "CI green", scope: ["project"], constraints: [], gaps: [] };
    const card = buildAcceptanceCard("debug: CI pipeline green", intent, baseFeas, "fix the ci fail");
    expect(card.warnings).toEqual([]);
  });

  it("no warning when raw has no debug signals", () => {
    const intent: ClarifiedIntent = { outcome: "Feature implemented", scope: ["project"], constraints: [], gaps: [] };
    const card = buildAcceptanceCard(
      "generate: Feature implemented and working",
      intent,
      baseFeas,
      "add a new button to the dashboard",
    );
    expect(card.warnings).toEqual([]);
  });
});
