import { describe, expect, it } from "vitest";
import { VERDICT_OUTPUT_CONTRACT } from "../../workflow/verdict-schema.js";
import { runPlanning } from "../planner.js";
import { buildSynthesisPrompt } from "../prompts.js";
import type { CouncilLLM, DebateState } from "../types.js";

const spec = {
  problemStatement: "Classify the measured MCP gap",
  constraints: [],
  successCriteria: [],
  scope: "test",
  rawQA: [],
};
const contract =
  'Return only JSON: {"recommendation":"known limitation","rationale":["evidence"],"dissenting_view":"bounded dissent"}.';
const answer = JSON.stringify({
  recommendation: "known limitation",
  rationale: ["evidence"],
  dissenting_view: "bounded dissent",
});

async function synthesize(replies: string[], outputContract?: string) {
  const calls: string[] = [];
  const llm: CouncilLLM = {
    async generate(_model, system) {
      calls.push(system);
      return replies[calls.length - 1] ?? "";
    },
    async research() {
      return "";
    },
    async debate() {
      return { text: "", toolCalls: [] };
    },
  };
  const state = { exchangeLogs: new Map(), active: [], roundCount: 1 } as unknown as DebateState;
  const gen = runPlanning(
    state,
    spec,
    [],
    "fixture-model",
    async () => false,
    llm,
    undefined,
    undefined,
    undefined,
    undefined,
    outputContract,
  );
  const chunks = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { result: step.value, calls, chunks };
    chunks.push(step.value);
  }
}

describe("caller-owned council output", () => {
  it("replaces the default dual output instead of appending another decision", () => {
    const { system } = buildSynthesisPrompt({
      spec,
      finalPositions: "measured positions",
      allExchanges: "",
      synthesisOutputContract: contract,
    });
    expect(system).toContain(contract);
    expect(system).not.toContain("Output TWO parts");
    expect(system).not.toContain("Next Actions (mandatory");
    expect(system).not.toContain("Additionally emit");
    expect(system).not.toContain("Part 2");
  });
  it("accepts custom JSON without summary/type and preserves the exact answer in one call", async () => {
    const { result, calls, chunks } = await synthesize([answer], contract);
    expect(calls).toHaveLength(1);
    expect(result.synthesisText).toBe(answer);
    expect(result.synthesisFailReason).toBeUndefined();
    expect(result.outcome).toBeNull();
    expect(chunks.find((c) => c.type === "council_message")?.councilMessage?.text).toBe(answer);
  });
  it("keeps the caller format on empty retry without imposing default sections", async () => {
    const { result, calls } = await synthesize(["", answer], contract);
    expect(calls).toHaveLength(2);
    expect(result.synthesisText).toBe(answer);
    expect(result.synthesisFailReason).toBeUndefined();
    for (const system of calls) {
      expect(system).toContain(contract);
      expect(system).not.toContain("---READABLE---");
    }
  });
  it("recovers a truncated custom JSON once using the same caller contract", async () => {
    const { result, calls } = await synthesize(['{"recommendation":', answer], contract);
    expect(calls).toHaveLength(2);
    expect(result.synthesisText).toBe(answer);
    expect(result.synthesisFailReason).toBeUndefined();
    expect(calls[1]).not.toContain("`summary`");
  });
  it("accepts a FLOW verdict fence without forcing a second synthesis", async () => {
    const verdict =
      '```council-verdict\n{"verdict":"revise","concerns":["scope"],"evidence":[],"rationale":"Review required"}\n```';
    const { result, calls } = await synthesize([verdict], VERDICT_OUTPUT_CONTRACT);
    expect(calls).toHaveLength(1);
    expect(result.synthesisText).toBe(verdict);
    expect(result.synthesisFailReason).toBeUndefined();
  });
  it.each([
    ["", ""],
    ['{"recommendation":', '{"recommendation":'],
  ])("reports an exhausted empty/truncated recovery without a successful custom result", async (...replies) => {
    const { result, calls } = await synthesize(replies, contract);
    expect(calls).toHaveLength(2);
    expect(result.synthesisFailReason).toBeTruthy();
  });
  it("preserves caller text containing literal braces without imposing JSON", async () => {
    const text = "The unresolved token is {placeholder; no code was changed.";
    const { result, calls } = await synthesize([text], "Return a plain text observation.");
    expect(calls).toHaveLength(1);
    expect(result.synthesisText).toBe(text);
    expect(result.synthesisFailReason).toBeUndefined();
  });
  it("retains standard interactive formatting without a nonblank caller contract", () => {
    const { system } = buildSynthesisPrompt({
      spec,
      finalPositions: "positions",
      allExchanges: "",
      synthesisOutputContract: "  ",
    });
    expect(system).toContain("Output TWO parts");
  });
});
