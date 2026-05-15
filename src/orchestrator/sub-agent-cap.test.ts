import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compressForCap, type SubAgentCapState, wrapToolSetWithCap } from "./sub-agent-cap.js";

function freshState(max: number, dedupEnabled = true): SubAgentCapState {
  return {
    cumulative: 0,
    max,
    exhausted: false,
    dedupHits: 0,
    seenHashes: new Map(),
    callIndex: 0,
    dedupEnabled,
    dedupMinChars: 500,
    midTierRatio: 0.3,
    highTierRatio: 0.7,
    midTierChars: 8_000,
    highTierChars: 2_000,
    label: "sub-agent",
  };
}

describe("compressForCap", () => {
  it("passes through small outputs while under 30% budget", () => {
    const state = freshState(100_000);
    const out = compressForCap(state, "x".repeat(1_000));
    expect(out.length).toBe(1_000);
    expect(state.cumulative).toBe(1_000);
    expect(state.exhausted).toBe(false);
  });

  it("trims to ~8k head/tail once over 30% budget", () => {
    const state = freshState(100_000);
    state.cumulative = 35_000;
    const out = compressForCap(state, "y".repeat(40_000));
    expect(out.length).toBeLessThan(40_000);
    expect(out).toContain("trimmed by sub-agent cap");
  });

  it("trims to ~2k head plus 'budget low' warning over 70% budget", () => {
    const state = freshState(100_000);
    state.cumulative = 75_000;
    const out = compressForCap(state, "z".repeat(20_000));
    expect(out).toContain("finalize work");
    expect(out.length).toBeLessThan(20_000);
  });

  it("emits exhausted stub once budget is fully spent", () => {
    const state = freshState(100_000);
    state.cumulative = 100_000;
    state.exhausted = true;
    const out = compressForCap(state, "w".repeat(10_000));
    expect(out).toContain("budget exhausted");
    expect(out).toContain("Summarize findings now");
  });

  it("dedups identical outputs across calls and returns a pointer", () => {
    const state = freshState(100_000);
    const payload = "DUP".repeat(500); // 1_500 chars, above the 500-char min
    const first = compressForCap(state, payload);
    expect(first).toBe(payload);
    expect(state.dedupHits).toBe(0);

    const second = compressForCap(state, payload);
    expect(second).toContain("duplicate tool output detected");
    expect(second).toContain("call #1");
    expect(state.dedupHits).toBe(1);
    // Cumulative should grow by stub length, NOT full payload length again.
    expect(state.cumulative).toBeLessThan(payload.length * 2);
  });

  it("skips dedup for outputs shorter than dedupMinChars", () => {
    const state = freshState(100_000);
    state.dedupMinChars = 500;
    const small = "x".repeat(200);
    compressForCap(state, small);
    const out = compressForCap(state, small);
    expect(out).toBe(small);
    expect(state.dedupHits).toBe(0);
  });

  it("dedup can be disabled via opts", () => {
    const state = freshState(100_000, false);
    const payload = "Y".repeat(1_000);
    compressForCap(state, payload);
    const out = compressForCap(state, payload);
    expect(out).toBe(payload);
    expect(state.dedupHits).toBe(0);
  });

  it("marks exhausted once cumulative reaches max", () => {
    const state = freshState(10_000);
    compressForCap(state, "a".repeat(9_000));
    expect(state.exhausted).toBe(false);
    compressForCap(state, "a".repeat(5_000));
    expect(state.exhausted).toBe(true);
  });
});

describe("wrapToolSetWithCap", () => {
  it("wraps execute and tracks cumulative output", async () => {
    const innerExec = vi.fn(async () => "hello-world");
    const tools: ToolSet = {
      sample: {
        description: "sample",
        inputSchema: { jsonSchema: { type: "object" } } as never,
        execute: innerExec,
      } as ToolSet[string],
    };
    const { tools: wrapped, state } = wrapToolSetWithCap(tools, { maxCumulativeChars: 20_000 });
    expect(wrapped.sample).toBeDefined();
    const execute = (wrapped.sample as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = await execute({});
    expect(out).toBe("hello-world");
    expect(state.cumulative).toBe("hello-world".length);
    expect(innerExec).toHaveBeenCalledOnce();
  });

  it("passes through tools without execute", () => {
    const tools: ToolSet = {
      bare: { description: "x", inputSchema: {} as never } as ToolSet[string],
    };
    const { tools: wrapped } = wrapToolSetWithCap(tools);
    expect(wrapped.bare).toBe(tools.bare);
  });

  it("honors custom tier ratios (top-level cap uses 50%/80%)", async () => {
    let counter = 0;
    const innerExec = async (): Promise<string> => {
      counter++;
      return `${counter}-` + "Z".repeat(20_000);
    };
    const tools: ToolSet = {
      sample: {
        description: "sample",
        inputSchema: {} as never,
        execute: innerExec,
      } as ToolSet[string],
    };
    const { tools: wrapped, state } = wrapToolSetWithCap(tools, {
      maxCumulativeChars: 100_000,
      midTierRatio: 0.5,
      highTierRatio: 0.8,
      label: "top-level",
    });
    state.cumulative = 40_000; // 40% — still under 50% → pass-through
    const execute = (wrapped.sample as unknown as { execute: (i: unknown) => Promise<string> }).execute;
    const first = await execute({});
    expect(first.length).toBeGreaterThanOrEqual(20_000); // untrimmed
    // Now jump to 60% — should trim head/tail. Distinct payload so dedup is bypassed.
    state.cumulative = 60_000;
    const second = await execute({});
    expect(second.length).toBeLessThan(20_000);
    expect(second).toContain("trimmed by top-level cap");
  });

  it("budget-exhausted stub uses the configured label", () => {
    const state = freshState(10_000);
    state.label = "top-level";
    state.cumulative = 10_000;
    state.exhausted = true;
    const out = compressForCap(state, "x".repeat(1_000));
    expect(out).toContain("top-level tool budget exhausted");
  });

  it("compresses object outputs with string `output` field", async () => {
    const innerExec = async () => ({ success: true, output: "Q".repeat(50_000), extra: 1 });
    const tools: ToolSet = {
      file: {
        description: "file",
        inputSchema: {} as never,
        execute: innerExec,
      } as ToolSet[string],
    };
    // Use small budget so the first call already lands in the trim tier.
    const { tools: wrapped, state } = wrapToolSetWithCap(tools, { maxCumulativeChars: 20_000 });
    state.cumulative = 7_000; // simulate prior usage in trim tier
    const execute = (wrapped.file as unknown as { execute: (i: unknown) => Promise<unknown> }).execute;
    const out = (await execute({})) as { success: boolean; output: string; extra: number };
    expect(out.success).toBe(true);
    expect(out.extra).toBe(1);
    expect(out.output.length).toBeLessThan(50_000);
    expect(out.output).toContain("trimmed");
  });
});
