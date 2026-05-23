import { describe, expect, it, vi } from "vitest";
import { createToolLoopCapPredicate, DEFAULT_TOOL_LOOP_BUMP } from "./tool-loop-cap.js";

function steps(n: number): { steps: ReadonlyArray<unknown> } {
  return { steps: Array.from({ length: n }, () => ({})) };
}

/**
 * Build a steps array where each step has a single bash tool call. Used by
 * the pattern-detector tests below. Pass an array of commands — one per step.
 */
function bashSteps(commands: string[]): { steps: ReadonlyArray<unknown> } {
  return {
    steps: commands.map((command) => ({
      toolCalls: [{ toolName: "bash", input: { command } }],
    })),
  };
}

describe("createToolLoopCapPredicate — cap guard", () => {
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
    expect(await stop(steps(100))).toBe(false);
    expect(ask).toHaveBeenCalledWith({ kind: "cap", stepNumber: 100, cap: 100, bumpBy: DEFAULT_TOOL_LOOP_BUMP });
    expect(await stop(steps(149))).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await stop(steps(150))).toBe(true);
    expect(ask).toHaveBeenLastCalledWith({ kind: "cap", stepNumber: 150, cap: 150, bumpBy: DEFAULT_TOOL_LOOP_BUMP });
  });

  it("respects custom bumpBy", async () => {
    const ask = vi.fn().mockResolvedValueOnce("continue").mockResolvedValueOnce("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 10, bumpBy: 5, ask });
    expect(await stop(steps(10))).toBe(false);
    expect(await stop(steps(14))).toBe(false);
    expect(await stop(steps(15))).toBe(true);
    expect(ask).toHaveBeenLastCalledWith({ kind: "cap", stepNumber: 15, cap: 15, bumpBy: 5 });
  });

  it("stop verdict halts without bumping the cap", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 5, ask });
    expect(await stop(steps(5))).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe("createToolLoopCapPredicate — pattern guard", () => {
  // Each call to stop(...) must show monotonically-growing step counts because
  // the predicate only processes the newly-added tail. We simulate streamText's
  // behaviour by calling stop after each new step.
  async function feed(stop: (s: { steps: ReadonlyArray<unknown> }) => Promise<boolean>, commands: string[]) {
    const verdicts: boolean[] = [];
    for (let i = 1; i <= commands.length; i++) {
      verdicts.push(await stop(bashSteps(commands.slice(0, i))));
    }
    return verdicts;
  }

  it("does not fire when patterns vary", async () => {
    const ask = vi.fn();
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    await feed(stop, ["git status", "ls -la", "git log -5", "bun run build", "cat README.md"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("fires when 3-of-5 bash calls collapse to the same canonical hash", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    const verdicts = await feed(stop, [
      "git status",
      "bunx vitest run | tail -20",
      "ls",
      "bunx vitest run | head -10",
      "bunx vitest run 2>&1 | grep FAIL",
    ]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({
      kind: "pattern",
      toolName: "bash",
      count: 3,
      windowSize: 5,
    });
    expect(verdicts[verdicts.length - 1]).toBe(true);
  });

  it("continue verdict clears the ring and resumes", async () => {
    const ask = vi.fn().mockResolvedValueOnce("continue");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    // Fire pattern detection on call 3.
    const v1 = await feed(stop, [
      "bunx vitest run | tail -20",
      "bunx vitest run | head -10",
      "bunx vitest run 2>&1 | grep FAIL",
    ]);
    expect(ask).toHaveBeenCalledOnce();
    // Continue → ring cleared → 3 more identical calls should NOT fire again
    // (one-shot per session).
    await feed(stop, ["bunx vitest run | tail -5", "bunx vitest run | head -5", "bunx vitest run > /tmp/x"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(v1.every((v) => v === false)).toBe(true);
  });

  it("respects custom patternWindow / patternThreshold", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({
      initialCap: 1000,
      ask,
      patternWindow: 3,
      patternThreshold: 2,
    });
    await feed(stop, ["git status", "bunx vitest run", "bunx vitest run | tail"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({
      kind: "pattern",
      toolName: "bash",
      count: 2,
      windowSize: 3,
    });
  });

  it("does not fire without an ask handler (headless safety)", async () => {
    const stop = createToolLoopCapPredicate({ initialCap: 1000 });
    const verdicts = await feed(stop, [
      "bunx vitest run | tail -20",
      "bunx vitest run | head -10",
      "bunx vitest run 2>&1 | grep FAIL",
    ]);
    expect(verdicts.every((v) => v === false)).toBe(true);
  });
});
