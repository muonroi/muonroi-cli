/**
 * Regression cover for the sprint-planning synthesis retry defect (session
 * 1f9f57415170, run mu3ks8zwe8d5): synthesis returned empty on BOTH attempts
 * against a reasoning leader (step-3.7-flash), and the retry actually asked for
 * LESS output budget (4096) than the first attempt already had (8192) —
 * backwards for an empty-because-reasoning-ate-the-budget failure, which needs
 * MORE room, not less. Truncated output (the model ran out of room mid-JSON)
 * genuinely needs the opposite: ask for less.
 *
 * These tests drive `runPlanning` directly with a mock `CouncilLLM.generate`
 * that records every `maxTokens` argument it receives, so the assertion is on
 * the ACTUAL wire budget planner.ts requests — never on an inferred constant.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import type { CouncilLLM, DebatePlan } from "../types.js";

interface RecordedCall {
  maxTokens?: number;
  system: string;
}

async function runPlanningCapturingCalls(opts: {
  leaderModelId: string;
  /** Sequential synthesisText replies, one per `generate()` call. */
  replies: string[];
  debatePlan?: DebatePlan;
}): Promise<{
  result: { outcome: unknown; plan: unknown; synthesisText: string; synthesisFailReason?: string };
  calls: RecordedCall[];
}> {
  const { runPlanning } = await import("../planner.js");
  const calls: RecordedCall[] = [];
  const llm: CouncilLLM = {
    async generate(_modelId, system, _prompt, maxTokens) {
      const idx = calls.length;
      calls.push({ maxTokens, system });
      return opts.replies[idx] ?? opts.replies[opts.replies.length - 1] ?? "";
    },
    async research() {
      return "";
    },
    async debate() {
      return { text: "", toolCalls: [] };
    },
  };
  const spec = {
    problemStatement: "test",
    constraints: [],
    successCriteria: [],
    scope: "test",
    rawQA: [],
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal DebateState stub, mirrors parse-outcome-fallback.test.ts
  const debateState: any = {
    spec,
    exchangeLogs: new Map(),
    runningSummary: "",
    roundCount: 1,
    active: [],
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal CouncilParticipant stub
  const participants: any = [{ role: "primary", model: opts.leaderModelId, position: "pos1" }];
  const gen = runPlanning(debateState, spec, participants, opts.leaderModelId, async () => false, llm, opts.debatePlan);
  let result: { outcome: unknown; plan: unknown; synthesisText: string; synthesisFailReason?: string } | undefined;
  while (true) {
    // biome-ignore lint/suspicious/noExplicitAny: generator yields StreamChunk we don't need to inspect here
    const step = await (gen as any).next();
    if (step.done) {
      result = step.value;
      break;
    }
  }
  if (!result) throw new Error("runPlanning generator never returned a result");
  return { result, calls };
}

describe("planner.ts — synthesis retry output budget", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("an empty first attempt retries with a budget >= the first attempt (fails today: it halves it)", async () => {
    const { calls } = await runPlanningCapturingCalls({
      // reasoning:true, catalog max_output_tokens:0 (unpublished ceiling sentinel)
      leaderModelId: "step-3.7-flash",
      replies: ["", ""],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxTokens).toBe(8192);
    expect(calls[1]?.maxTokens).toBeGreaterThanOrEqual(calls[0]?.maxTokens as number);
  });

  it("PINS the unpublished-ceiling case (step-3.7-flash — the exact leader from the incident): retry is STRICTLY greater, not a repeat of the same ask", async () => {
    // This is the case the earlier version of this fix missed: catalog
    // max_output_tokens:0 resolved to DEFAULT_REASONING_OUTPUT_BUDGET_TOKENS
    // (8192), numerically identical to the first attempt's own budget — so the
    // "never smaller than the first attempt" contract held, but the retry was
    // byte-for-byte the SAME request that already returned empty four times in
    // the real incident (session 1f9f57415170 / run mu3ks8zwe8d5).
    const { calls } = await runPlanningCapturingCalls({
      leaderModelId: "step-3.7-flash",
      replies: ["", ""],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxTokens).toBe(8192);
    expect(calls[1]?.maxTokens).toBeGreaterThan(calls[0]?.maxTokens as number);
    // Derived (default * multiplier), not a second bare literal — see
    // UNPUBLISHED_CEILING_RETRY_MULTIPLIER's doc comment.
    expect(calls[1]?.maxTokens).toBe(16384);
  });

  it("sizes the empty-retry budget from the model's OWN catalog ceiling when one is published (above the first attempt)", async () => {
    const { calls } = await runPlanningCapturingCalls({
      // reasoning:true, catalog max_output_tokens: 16000 (a REAL published ceiling)
      leaderModelId: "deepseek-v4-pro",
      replies: ["", ""],
    });
    expect(calls).toHaveLength(2);
    // Must come from the catalog, not from doubling/inventing a literal.
    expect(calls[1]?.maxTokens).toBe(16000);
    expect(calls[1]?.system).toContain("LARGER output budget");
  });

  it("is honest when a PUBLISHED ceiling does not allow more room than the first attempt", async () => {
    // step-3.5-flash: reasoning:true, catalog max_output_tokens: 8192 — a real
    // published ceiling that happens to equal the first attempt's own budget.
    // The retry must not shrink (still 8192) but must also not CLAIM more room
    // than it is actually asking for.
    const { calls } = await runPlanningCapturingCalls({
      leaderModelId: "step-3.5-flash",
      replies: ["", '{"type":"decision","summary":"Answered on retry with the same declared ceiling."}'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.maxTokens).toBe(8192);
    expect(calls[1]?.system).not.toContain("LARGER output budget");
    expect(calls[1]?.system).toContain("SAME output budget");
  });

  it("a truncated first attempt still retries with the SMALLER, ask-for-less budget (guards the other case)", async () => {
    // Never closes — extractJsonObject must classify this as truncated, not empty/unparseable.
    const truncated = '{"summary": "cut off mid-object and this JSON string never closes';
    const { calls } = await runPlanningCapturingCalls({
      leaderModelId: "step-3.7-flash",
      replies: [truncated, '{"type":"decision","summary":"Fits inside the compact retry budget this time."}'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.maxTokens).toBe(4096);
    expect(calls[1]?.system).toContain("keep it SMALL");
    expect(calls[1]?.system).not.toContain("LARGER output budget");
  });

  it("the empty-completion retry directive asks for MORE room, never tells the model to 'keep it SMALL'", async () => {
    const { calls } = await runPlanningCapturingCalls({
      leaderModelId: "step-3.7-flash",
      replies: ["", '{"type":"decision","summary":"Answered on retry now that there is more room."}'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.system).toContain("LARGER output budget");
    expect(calls[1]?.system).not.toContain("keep it SMALL");
  });
});
