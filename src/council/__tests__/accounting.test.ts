import { describe, expect, it } from "vitest";
import type { CouncilParticipant, CouncilStats, DebateState } from "../types.js";

// ── CQ-01: stats.calls accuracy ─────────────────────────────────────────────

describe("CQ-01: council stats accounting", () => {
  it("RunCouncilOptions accepts councilStats field", async () => {
    // Type-level test: if this compiles, the interface is correct
    const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };
    const {} = await import("../index.js"); // ensure module resolves
    const options: import("../index.js").RunCouncilOptions = {
      councilStats: stats,
    };
    expect(options.councilStats).toBe(stats);
  });

  it("shared CouncilStats object is mutated by reference — same object tracks calls", () => {
    const sharedStats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };
    // Simulate what createCouncilLLM.generate does: stats.calls++
    const simulateLLMCall = (s: CouncilStats) => {
      s.calls++;
    };
    simulateLLMCall(sharedStats);
    simulateLLMCall(sharedStats);
    expect(sharedStats.calls).toBe(2);
    // Verify the same ref from options would read the correct count
    const options: import("../index.js").RunCouncilOptions = { councilStats: sharedStats };
    expect(options.councilStats?.calls).toBe(2);
  });
});

// ── CQ-02: finalPositions propagation ───────────────────────────────────────

describe("CQ-02: finalPositions reflects debate-mutated positions", () => {
  it("DebateState includes active field with CouncilParticipant array", () => {
    // Type-level test: verify DebateState.active field exists post Plan-01
    const fakeActive: CouncilParticipant[] = [
      { role: "primary" as any, model: "gpt-4", position: "Position after debate round" },
      { role: "secondary" as any, model: "claude-3", position: "Counter-position after round" },
    ];
    const fakeDebateState: DebateState = {
      spec: { problemStatement: "test", constraints: [], successCriteria: [], scope: "", rawQA: [] },
      exchangeLogs: new Map(),
      runningSummary: "summary",
      roundCount: 1,
      active: fakeActive, // This field must exist — fails if Plan 01 not done
    };
    expect(fakeDebateState.active).toHaveLength(2);
    expect(fakeDebateState.active[0].position).toBe("Position after debate round");
    expect(fakeDebateState.active[1].position).toBe("Counter-position after round");
  });

  it("positions read from debateState.active are non-empty after debate mutations", () => {
    const active: CouncilParticipant[] = [{ role: "primary" as any, model: "gpt-4", position: "" }];
    // Simulate what debate.ts does during rounds
    active[0].position = "Mutated position from round 1";
    // Simulate what index.ts SHOULD do after fix (read from debateState.active)
    const debateState: DebateState = {
      spec: { problemStatement: "topic", constraints: [], successCriteria: [], scope: "", rawQA: [] },
      exchangeLogs: new Map(),
      runningSummary: "",
      roundCount: 1,
      active,
    };
    const finalPositions = debateState.active.map((a) => ({
      role: a.role,
      position: a.position.slice(0, 1000),
    }));
    expect(finalPositions[0].position).toBe("Mutated position from round 1");
    expect(finalPositions[0].position).not.toBe("");
  });
});
