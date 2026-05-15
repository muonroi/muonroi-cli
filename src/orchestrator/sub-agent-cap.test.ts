import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { compressForCap, type SubAgentCapState, wrapToolSetWithCap } from "./sub-agent-cap.js";

function freshState(max: number): SubAgentCapState {
  return { cumulative: 0, max, exhausted: false };
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
    const state: SubAgentCapState = { cumulative: 35_000, max: 100_000, exhausted: false };
    const out = compressForCap(state, "y".repeat(40_000));
    expect(out.length).toBeLessThan(40_000);
    expect(out).toContain("trimmed by sub-agent cap");
  });

  it("trims to ~2k head plus 'budget low' warning over 70% budget", () => {
    const state: SubAgentCapState = { cumulative: 75_000, max: 100_000, exhausted: false };
    const out = compressForCap(state, "z".repeat(20_000));
    expect(out).toContain("finalize work");
    expect(out.length).toBeLessThan(20_000);
  });

  it("emits exhausted stub once budget is fully spent", () => {
    const state: SubAgentCapState = { cumulative: 100_000, max: 100_000, exhausted: true };
    const out = compressForCap(state, "w".repeat(10_000));
    expect(out).toContain("budget exhausted");
    expect(out).toContain("Summarize findings now");
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
