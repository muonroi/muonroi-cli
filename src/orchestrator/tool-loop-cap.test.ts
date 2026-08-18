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

  // Phase 5 BUG-F+G: verification commands (vitest/tsc/test/lint) are now
  // exempt from pattern detection — agents re-run them as part of normal
  // edit→typecheck→fix cycles, and counting them as loop tripped the askcard
  // on legitimate work. We swap to git diff invocations for the same scenario.
  it("fires when 3-of-5 bash calls collapse to the same canonical hash", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    const verdicts = await feed(stop, [
      "ls -la",
      "cat package.json",
      "git diff HEAD",
      "git diff HEAD > /tmp/diff.txt",
      "git diff HEAD 2>&1",
    ]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({
      kind: "pattern",
      toolName: "bash",
      count: 3,
      windowSize: 5,
      stepNumber: 5,
      naturalCeiling: undefined,
    });
    expect(verdicts[verdicts.length - 1]).toBe(true);
  });

  it("continue verdict clears the ring and resumes", async () => {
    const ask = vi.fn().mockResolvedValueOnce("continue");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    // Fire pattern detection on call 3.
    const v1 = await feed(stop, ["git diff HEAD | head", "git diff HEAD | tail", "git diff HEAD > /tmp/x"]);
    expect(ask).toHaveBeenCalledOnce();
    // Continue → ring cleared → 3 more identical calls should NOT fire again
    // (one-shot per session).
    await feed(stop, ["git diff HEAD | wc -l", "git diff HEAD | grep diff", "git diff HEAD > /tmp/y"]);
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
    await feed(stop, ["git status", "git diff HEAD", "git diff HEAD > /tmp/x"]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({
      kind: "pattern",
      toolName: "bash",
      count: 2,
      windowSize: 3,
      stepNumber: 3,
      naturalCeiling: undefined,
    });
  });

  it("does not fire without an ask handler (headless safety)", async () => {
    const stop = createToolLoopCapPredicate({ initialCap: 1000 });
    const verdicts = await feed(stop, ["git diff HEAD | head", "git diff HEAD | tail", "git diff HEAD > /tmp/x"]);
    expect(verdicts.every((v) => v === false)).toBe(true);
  });

  // Phase 5 BUG-F — verification commands MUST NOT trigger the pattern guard
  // even when run 5x in a row (edit→typecheck→fix iteration is normal work).
  it("does NOT fire when verification commands are repeated", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    await feed(stop, ["bunx tsc --noEmit", "bunx tsc --noEmit", "bunx tsc --noEmit", "bunx tsc --noEmit"]);
    expect(ask).not.toHaveBeenCalled();
  });

  // Phase 5 BUG-G — pipe-native tools (grep, sed, awk, jq, find) preserve
  // their pipe chain in the canonical form because the pipe IS the query.
  // Three legitimately-different grep filter chains on the same file should
  // NOT collide.
  it("does NOT fire when grep pipe-chains differ on the same target", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 1000, ask });
    await feed(stop, [
      'grep -n "^import " src/index.ts | head -60',
      'grep -n "^import " src/index.ts | wc -l',
      'grep -n "^import " src/index.ts | grep -v type',
    ]);
    expect(ask).not.toHaveBeenCalled();
  });

  // Phase 5 BUG-H — pattern info carries stepNumber + naturalCeiling so the
  // UI can pick a context-aware default action.
  it("propagates stepNumber and naturalCeiling to the ask handler", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({
      initialCap: 1000,
      ask,
      naturalCeiling: 18,
    });
    await feed(stop, [
      "git diff HEAD",
      "git diff HEAD | head",
      "ls",
      "git diff HEAD | wc -l", // <- pattern fires here (3 git-diffs in window)
      "git diff HEAD > /tmp/x",
    ]);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "pattern",
        stepNumber: 4,
        naturalCeiling: 18,
      }),
    );
  });
});

describe("createToolLoopCapPredicate — all-error backstop (session 5349b59e16bf)", () => {
  // Each step calls bash_output_get with a DIFFERENT (guessed) run_id and gets an
  // ERROR back — the exact 800k-token loop. Different args ⇒ the args-hash
  // detector never fires; the all-error signature collapses them so it does.
  const errStep = (run_id: string) => ({
    toolCalls: [{ toolName: "bash_output_get", input: { run_id, mode: "full" } }],
    toolResults: [
      { toolName: "bash_output_get", output: { type: "text", value: `ERROR: No cached bash run with id '${run_id}'.` } },
    ],
  });

  it("fires the pattern guard after 3 all-error steps despite varying args", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 100, ask });
    const all = [errStep("bash-0"), errStep("bash-1"), errStep("bash-2")];
    let verdict = false;
    for (let i = 1; i <= all.length; i++) verdict = await stop({ steps: all.slice(0, i) });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ kind: "pattern", toolName: "bash_output_get" }));
    expect(verdict).toBe(true);
  });

  it("does NOT fire when steps make progress (a non-error result present)", async () => {
    const ask = vi.fn().mockResolvedValue("stop");
    const stop = createToolLoopCapPredicate({ initialCap: 100, ask });
    // Distinct productive bash commands, each succeeding → never all-error, never
    // identical args → no loop signal.
    const okStep = (i: number) => ({
      toolCalls: [{ toolName: "bash", input: { command: `echo step-${i}` } }],
      toolResults: [{ toolName: "bash", output: { type: "text", value: `[bash_run_id: bash-${i}] step-${i}` } }],
    });
    const all = [okStep(1), okStep(2), okStep(3), okStep(4)];
    for (let i = 1; i <= all.length; i++) await stop({ steps: all.slice(0, i) });
    expect(ask).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "pattern" }));
  });
});
