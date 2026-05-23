import { describe, expect, it, vi } from "vitest";
import { createToolLoopCapPredicate, DEFAULT_TOOL_LOOP_BUMP } from "./tool-loop-cap.js";

function steps(n: number): { steps: ReadonlyArray<unknown> } {
  return { steps: Array.from({ length: n }, () => ({})) };
}

describe("createToolLoopCapPredicate", () => {
  it("returns false while step count is below cap", async () => {
    const stop = createToolLoopCapPredicate({ initialCap: 100 });
    expect(await stop(steps(0))).toBe(false);
    expect(await stop(steps(50))).toBe(false);
    expect(await stop(steps(99))).toBe(false);
  });

  it("hard-stops at the cap when no ask handler is wired (legacy headless)", async () => {
    const stop = createToolLoopCapPredicate({ initialCap: 10 });
    expect(await stop(steps(10))).toBe(true);
  });

  it("continue verdict raises the cap by the default bump (50) and resumes", async () => {
    const ask = vi.fn().mockResolvedValueOnce("continue").mockResolvedValueOnce("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 100, ask });
    // Step 100 hits cap → ask fires once → continue → cap=150, returns false.
    expect(await stop(steps(100))).toBe(false);
    expect(ask).toHaveBeenCalledWith({ stepNumber: 100, cap: 100, bumpBy: DEFAULT_TOOL_LOOP_BUMP });
    // Below new cap → no ask, false.
    expect(await stop(steps(149))).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    // Hit new cap → ask fires again with raised cap → stop → returns true.
    expect(await stop(steps(150))).toBe(true);
    expect(ask).toHaveBeenLastCalledWith({ stepNumber: 150, cap: 150, bumpBy: DEFAULT_TOOL_LOOP_BUMP });
  });

  it("respects custom bumpBy", async () => {
    const ask = vi.fn().mockResolvedValueOnce("continue").mockResolvedValueOnce("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 10, bumpBy: 5, ask });
    expect(await stop(steps(10))).toBe(false); // cap → 15
    expect(await stop(steps(14))).toBe(false);
    expect(await stop(steps(15))).toBe(true);
    expect(ask).toHaveBeenLastCalledWith({ stepNumber: 15, cap: 15, bumpBy: 5 });
  });

  it("stop verdict halts without bumping the cap", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 5, ask });
    expect(await stop(steps(5))).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });
});
