/**
 * src/orchestrator/tool-loop-cap.ts
 *
 * Pure factory for the AI-SDK `stopWhen` predicate that backs the
 * Claude-Code-style "Agent loop guard" feature: when the streamText loop hits
 * the cap, ask the user; on "continue" raise the cap by a fixed bump and let
 * the loop keep running. Default bump is 50 rounds.
 *
 * Extracted from message-processor.ts so we can unit-test the algorithm
 * without standing up a full streamText harness.
 */

export interface ToolLoopCapAskInfo {
  stepNumber: number;
  cap: number;
  bumpBy: number;
}

export type ToolLoopCapAsk = (info: ToolLoopCapAskInfo) => Promise<"continue" | "stop">;

export interface ToolLoopCapOptions {
  initialCap: number;
  bumpBy?: number;
  ask?: ToolLoopCapAsk;
}

export const DEFAULT_TOOL_LOOP_BUMP = 50;

/**
 * Build the async stopWhen predicate.
 *
 *   - `sn < cap`            → false (keep going)
 *   - cap hit, no `ask`     → true  (legacy hard-stop, batch / headless)
 *   - cap hit, ask=continue → bump cap by `bumpBy`, return false (resume)
 *   - cap hit, ask=stop     → true  (graceful halt)
 *
 * Returns a predicate that closes over a mutable `cap` so subsequent steps
 * see the raised ceiling. Tests assert this drift.
 */
export function createToolLoopCapPredicate(
  opts: ToolLoopCapOptions,
): (state: { steps: ReadonlyArray<unknown> }) => Promise<boolean> {
  let cap = opts.initialCap;
  const bumpBy = opts.bumpBy ?? DEFAULT_TOOL_LOOP_BUMP;
  const ask = opts.ask;
  return async ({ steps }) => {
    const sn = steps.length;
    if (sn < cap) return false;
    if (!ask) return true;
    const verdict = await ask({ stepNumber: sn, cap, bumpBy });
    if (verdict === "continue") {
      cap += bumpBy;
      return false;
    }
    return true;
  };
}
