/**
 * Ceiling fit for worker prompts (fitSubAgentMessagesToCeiling).
 *
 * Reproduces the gentle-violet-panda shape (session 4edc02516a92): a
 * test-fixing worker whose grep/read results mention "fail"/"error" — so the
 * ordinary B3 pass keeps them verbatim at any size — on a reasoning model whose
 * kept-tail reasoning is never stripped. The real job's last request was
 * est 105,939 > 100,000 tokens and the gate failed the job.
 */
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePrompt, type CallComposition, enforceCeiling } from "../../providers/model-gate.js";
import { compactSubAgentMessages, fitSubAgentMessagesToCeiling } from "../subagent-compactor.js";

const SYSTEM = "s".repeat(44_000); // worker system prompt size measured in the job (43,987 chars)
const THROW_AT = 100_000; // default MUONROI_GATE_THROW_MAX_TOKENS
const BUDGET = Math.floor(THROW_AT * 0.9);

const measure = (messages: ReadonlyArray<ModelMessage>) =>
  analyzePrompt([{ role: "system", content: SYSTEM }, ...messages]).estInputTokens;

function gateWouldThrow(messages: ReadonlyArray<ModelMessage>): boolean {
  const comp: CallComposition = analyzePrompt([{ role: "system", content: SYSTEM }, ...messages]);
  try {
    enforceCeiling(comp, { stage: "subagent", modelId: "worker-model" });
    return false;
  } catch (err) {
    expect((err as Error).message).toMatch(/^Input ceiling exceeded on 'subagent' call/);
    return true;
  }
}

/** One worker step: assistant (reasoning + tool call) followed by its tool result. */
function step(i: number, resultChars: number, reasoningChars: number): ModelMessage[] {
  const id = `call_${i}`;
  const body = `[src/tests/Parser.Tests/ParserTests.cs: lines 1-400 of 900] Assert failed: expected 2, got 4 `;
  return [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: `think-${i} ${"r".repeat(reasoningChars)}` },
        { type: "tool-call", toolCallId: id, toolName: "grep", input: { pattern: `Fail${i}` } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "grep",
          output: { type: "text", value: `${body}${"x".repeat(resultChars - body.length)}` },
        },
      ],
    },
  ];
}

/**
 * The job's history segment (205,525 chars) is reasoning the B3 pass keeps: its
 * three kept tail steps took ~125s, ~6s and ~156s on step-5-preview, which
 * emitted 8,291 output tokens in a 60s step and 8,202 in a 46s step in the same
 * session — so the tail steps carry tens of thousands of reasoning chars each.
 */
function workerHistory(steps: number, tailReasoningChars = 60_000): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: "user", content: "Fix the 7 failing MarkdownParser tests." }];
  for (let i = 0; i < steps; i++) msgs.push(...step(i, 9_000, i >= steps - 3 ? tailReasoningChars : 10_000));
  return msgs;
}

const savedThrow = process.env.MUONROI_GATE_THROW_MAX_TOKENS;
const savedMode = process.env.MUONROI_GATE_CEILING;
afterEach(() => {
  if (savedThrow === undefined) delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
  else process.env.MUONROI_GATE_THROW_MAX_TOKENS = savedThrow;
  if (savedMode === undefined) delete process.env.MUONROI_GATE_CEILING;
  else process.env.MUONROI_GATE_CEILING = savedMode;
});

describe("fitSubAgentMessagesToCeiling", () => {
  it("the ordinary B3 pass leaves a long test-fixing worker over the gate line (the bug)", () => {
    delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
    delete process.env.MUONROI_GATE_CEILING;
    const history = workerHistory(20);
    // Worker options from stream-runner: 40k threshold, keep 3, 1M window, reasoning model.
    const b3 = compactSubAgentMessages(history, {
      thresholdChars: 40_000,
      keepLastTurns: 3,
      contextWindowTokens: 1_000_000,
      contextFillRatio: 0.3,
      stripOldReasoning: true,
    });
    expect(b3).not.toBe(history); // B3 did run ...
    expect(measure(b3)).toBeGreaterThan(THROW_AT); // ... and kept every "failed" result verbatim
    expect(JSON.stringify(b3)).not.toContain("elided by sub-agent compactor");
    expect(gateWouldThrow(b3)).toBe(true);
  });

  it("compacts before the ceiling: the fitted view passes the gate and stays rehydratable", () => {
    delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
    delete process.env.MUONROI_GATE_CEILING;
    const history = workerHistory(20);
    const persisted: string[] = [];
    const elided: string[] = [];
    const fit = fitSubAgentMessagesToCeiling(history, {
      budgetTokens: BUDGET,
      measureTokens: measure,
      compactor: {
        keepLastTurns: 3,
        persistArtifact: (id) => persisted.push(id),
        onElide: (ids) => elided.push(...ids),
      },
    });
    expect(fit.estBefore).toBeGreaterThan(THROW_AT);
    expect(fit.level).toBe(1);
    expect(fit.fitted).toBe(true);
    expect(fit.estAfter).toBeLessThanOrEqual(BUDGET);
    expect(gateWouldThrow(fit.messages)).toBe(false);

    // Same message count: the assistant<->tool pairing is preserved.
    expect(fit.messages).toHaveLength(history.length);
    // Older keep-verbatim results were stubbed AND their content handed off for retrieve_tool_result.
    expect(persisted).toContain("call_0");
    expect(elided).toContain("call_0");
    const text = JSON.stringify(fit.messages);
    expect(text).toContain("call_0) — 9000 chars elided by sub-agent compactor");
    // The last 3 tool turns stay verbatim; only the newest assistant keeps its reasoning.
    expect(persisted).not.toContain("call_19");
    expect(persisted).not.toContain("call_17");
    expect(text).toContain("think-19 ");
    expect(text).not.toContain("think-18 ");
  });

  it("returns the input by identity when it already fits", () => {
    const history = workerHistory(2);
    const fit = fitSubAgentMessagesToCeiling(history, { budgetTokens: BUDGET, measureTokens: measure });
    expect(fit.level).toBe(0);
    expect(fit.messages).toBe(history);
  });

  it("escalates to a single verbatim turn when three do not fit", () => {
    const history = workerHistory(20);
    // Budget below system + 3 tail turns but above system + 1 tail turn.
    const budget = measure(history.slice(0, 1)) + 21_000;
    const fit = fitSubAgentMessagesToCeiling(history, {
      budgetTokens: budget,
      measureTokens: measure,
      compactor: { keepLastTurns: 3 },
    });
    expect(fit.level).toBe(2);
    expect(fit.fitted).toBe(true);
    expect(fit.estAfter).toBeLessThanOrEqual(budget);
  });

  it("strips even the newest reasoning as a last resort when it alone keeps the request over", () => {
    const history = workerHistory(20, 400_000);
    const fit = fitSubAgentMessagesToCeiling(history, {
      budgetTokens: BUDGET,
      measureTokens: measure,
      compactor: { keepLastTurns: 3 },
    });
    expect(fit.level).toBe(3);
    expect(fit.fitted).toBe(true);
    expect(JSON.stringify(fit.messages)).not.toContain("think-19 ");
    expect(gateWouldThrow(fit.messages)).toBe(false);
  });

  it("never weakens the gate: an irreducible prompt comes back unfitted and the gate still throws", () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "5000"; // below the 44k-char system prompt alone
    const history = workerHistory(20);
    const fit = fitSubAgentMessagesToCeiling(history, {
      budgetTokens: 4_500,
      measureTokens: measure,
      compactor: { keepLastTurns: 3 },
    });
    expect(fit.fitted).toBe(false);
    expect(fit.estAfter).toBeLessThan(fit.estBefore);
    expect(gateWouldThrow(fit.messages)).toBe(true);
  });
});
