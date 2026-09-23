import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendDecisionLog, readDecisionLog } from "../decision-log.js";

describe("decision-log scope-gate kind", () => {
  it("accepts and round-trips a scope-gate entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "declog-"));
    await appendDecisionLog(
      { ts: 1, sessionId: "s1", kind: "scope-gate", taken: false, reason: "external", meta: { scopeKind: "external" } },
      home,
    );
    const rows = await readDecisionLog(undefined, home);
    expect(rows.some((r) => r.kind === "scope-gate")).toBe(true);
  });
});

describe("decision-log auto-council observability (session 115a59c9bb9e -> child 49f6b8c1d8d6)", () => {
  // Round-trips the EXACT meta shape tool-engine.ts's auto-council gate now
  // writes (see settled-synthesis-gate.ts wiring), so "why was a council
  // convened, which signal triggered it, and did prior settled context
  // exist?" is answerable from this log without guessing — the gap the
  // original defect investigation hit (no row for the decision anywhere).
  it("round-trips assessorFired + prior-synthesis fields for a suppressed heavy-tier-only trigger", async () => {
    const home = mkdtempSync(join(tmpdir(), "declog-"));
    await appendDecisionLog(
      {
        ts: 2,
        sessionId: "child-session",
        kind: "auto-council",
        taken: false,
        reason: 'settled-prior-synthesis topic="integrate automation framework" similarity=0.87',
        meta: {
          taskType: "generate",
          confidence: 0.98,
          complexityTier: "heavy",
          modelDepthTier: "heavy",
          heavyTier: true,
          assessorFired: true,
          priorSynthesisFound: true,
          priorSynthesisTopic: "integrate automation framework",
          priorSynthesisSimilarity: 0.87,
          suppressedForSettledSynthesis: true,
        },
      },
      home,
    );

    const rows = await readDecisionLog(undefined, home);
    const row = rows.find((r) => r.kind === "auto-council");

    expect(row).toBeDefined();
    expect(row?.taken).toBe(false);
    expect(row?.meta?.assessorFired).toBe(true);
    expect(row?.meta?.priorSynthesisFound).toBe(true);
    expect(row?.meta?.suppressedForSettledSynthesis).toBe(true);
    expect(row?.reason).toContain("settled-prior-synthesis");
  });

  it("round-trips assessorFired=false + priorSynthesisFound=false for the un-suppressed regression case", async () => {
    const home = mkdtempSync(join(tmpdir(), "declog-"));
    await appendDecisionLog(
      {
        ts: 3,
        sessionId: "parent-session",
        kind: "auto-council",
        taken: true,
        reason: "taken",
        meta: {
          taskType: "generate",
          confidence: 0.9,
          complexityTier: "heavy",
          heavyTier: true,
          // No leader-tier assessor verdict this turn — heavyTier came from
          // the raw complexityTier heuristic fallback.
          assessorFired: false,
          priorSynthesisFound: false,
          priorSynthesisTopic: null,
          priorSynthesisSimilarity: null,
          suppressedForSettledSynthesis: false,
        },
      },
      home,
    );

    const rows = await readDecisionLog(undefined, home);
    const row = rows.find((r) => r.kind === "auto-council");

    expect(row?.taken).toBe(true);
    expect(row?.meta?.assessorFired).toBe(false);
    expect(row?.meta?.priorSynthesisFound).toBe(false);
  });
});
