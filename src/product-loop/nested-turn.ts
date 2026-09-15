/**
 * src/product-loop/nested-turn.ts
 *
 * The ONE seam through which a product-loop stage forwards a NESTED stream
 * (a `processMessageFn` turn, a `runCouncil` sub-step) into the `/ideal` stream.
 *
 * Why it exists. `{type:"done"}` is the TURN terminator: the TUI ends its
 * `/ideal` for-await on the first one it sees (use-app-logic.tsx:5277
 * `if (chunk.type === "done") break;`). Every nested turn emits one — on normal
 * completion (tool-engine.ts:4570) and when the turn watchdog kills it
 * (orchestrator.ts:3708-3709). A stage that forwards the nested stream verbatim
 * therefore ends the whole `/ideal` run mid-sprint with no halt card, no error
 * card and no terminal event. That happened twice:
 *   - P0-1 (2026-09-04, run mtmkya3uaf85): the planning council's early-bail
 *     `done` — fixed with an inline guard at that one site only.
 *   - run mtwnfp8p3869 (session d4fd0b77f6a6): the completeness re-check turn
 *     was killed by the watchdog at 08:41:14; its `error` then `done` were
 *     forwarded, the TUI dropped the user back at the chat prompt, and nothing
 *     further was recorded. The implementation and re-check loops had never
 *     received the P0-1 guard.
 * Routing every nested forward through this helper makes the terminator strip
 * structural instead of something each new consumer has to remember.
 *
 * What it does NOT strip: every other chunk, `error` included, still reaches
 * the transcript — the user must still see "Turn ended by watchdog: …".
 */

import type { StreamChunk } from "../types/index.js";

export interface NestedTurnOutcome<R> {
  /** The nested generator's own return value (e.g. `runCouncil`'s synthesis). */
  value: R;
  /**
   * The error text when the nested turn TERMINATED in failure, else `null`.
   *
   * "Terminated in failure" = its terminator (`done`, or the end of the stream)
   * arrived immediately after an `error` chunk. That is the shape every
   * turn-ending failure path emits, back to back: the turn watchdog
   * (orchestrator.ts:3708-3709), a provider stall (tool-engine.ts:3799-3800), a
   * thrown provider error (tool-engine.ts:4678 → 4724, nothing yielded between),
   * the per-turn LLM-call cap (tool-engine.ts:2035-2040), the tool-repetition
   * abort (tool-engine.ts:3312-3313), and batch mode (batch-turn-runner.ts:354-355,
   * 414-419). An `error` followed by further output is a turn that kept going,
   * so it is not counted.
   */
  failure: string | null;
}

function errorText(chunk: StreamChunk): string {
  const text = typeof chunk.content === "string" ? chunk.content.trim() : "";
  return text || "nested turn ended with an error chunk that carried no message";
}

/**
 * The ONE implementation of the `NestedTurnOutcome.failure` rule above.
 *
 * It is factored out rather than inlined because a nested stream has two kinds
 * of consumer and only one of them was forwarding. The COLLECTING consumers —
 * `product-loop/sprint-runner.buildVerifyAgent` and
 * `maintain/task-runner.buildVerifyAgent` — ran their own loop that kept only
 * `content` chunks and dropped everything else, `error` included, then returned
 * `{success:true, output}` unconditionally. A verify turn killed by the turn
 * watchdog therefore reported a successful verify over whatever partial text had
 * arrived, and `parseVerifyResult` scored the sprint on it. Giving those callers
 * a second, hand-written copy of the rule would let the two drift; they share
 * this one via `collectNestedTurn`.
 */
interface NestedTurnFailureTracker {
  /** Feed every chunk, in stream order, before acting on it. */
  observe(chunk: StreamChunk): void;
  /** Call once the nested generator has returned; yields the failure text. */
  end(): string | null;
}

function createNestedTurnFailureTracker(): NestedTurnFailureTracker {
  let failure: string | null = null;
  // Error text of the most recently seen chunk when it was an `error`.
  let pendingError: string | null = null;
  return {
    observe(chunk: StreamChunk): void {
      if (chunk?.type === "done") {
        if (failure === null && pendingError !== null) failure = pendingError;
        pendingError = null;
        return;
      }
      pendingError = chunk?.type === "error" ? errorText(chunk) : null;
    },
    end(): string | null {
      if (failure === null && pendingError !== null) failure = pendingError;
      return failure;
    },
  };
}

/** What a COLLECTING consumer gets back from `collectNestedTurn`. */
export interface CollectedNestedTurn {
  /** Every `content` chunk's text, concatenated in stream order. */
  output: string;
  /** Same contract as `NestedTurnOutcome.failure`. */
  failure: string | null;
}

/**
 * Drain a nested stream into a payload string and report how it ended.
 *
 * The collecting counterpart of `forwardNestedTurn`, for stages whose nested
 * turn is machine-read rather than shown: they must NOT forward the chunks (the
 * `/ideal` stream would end on the nested `done` — see the file header) but they
 * must still know that the turn was killed, so the payload is not mistaken for a
 * finished one.
 */
export async function collectNestedTurn(
  gen: AsyncGenerator<StreamChunk, unknown, unknown>,
): Promise<CollectedNestedTurn> {
  const tracker = createNestedTurnFailureTracker();
  let output = "";
  // `for await` unwinds the nested generator on an early exit or a throw, the
  // same as the `finally` in forwardNestedTurn does; a throw still propagates so
  // the caller's own `finally` (e.g. the recall-nag scope release) runs.
  for await (const chunk of gen) {
    tracker.observe(chunk);
    if (chunk?.type === "content" && typeof chunk.content === "string") {
      output += chunk.content;
    }
  }
  return { output, failure: tracker.end() };
}

/**
 * Forward a nested stream's chunks upward, minus its `{type:"done"}`
 * terminators, and report how it ended. Use with `yield*`.
 */
export async function* forwardNestedTurn<R>(
  gen: AsyncGenerator<StreamChunk, R, unknown>,
): AsyncGenerator<StreamChunk, NestedTurnOutcome<R>, unknown> {
  const tracker = createNestedTurnFailureTracker();
  let finished = false;
  try {
    while (true) {
      const step = await gen.next();
      if (step.done) {
        finished = true;
        return { value: step.value, failure: tracker.end() };
      }
      const chunk = step.value;
      tracker.observe(chunk);
      if (chunk?.type === "done") {
        // A nested terminator is not this stage's terminator — see file header.
        continue;
      }
      yield chunk;
    }
  } finally {
    // Same unwinding a `for await` does: when OUR consumer stops early (Esc →
    // `gen.return()`), tell the nested generator so its own `finally` blocks
    // (write-mutex release, permission-mode restore at orchestrator.ts:2521)
    // still run. Skipped once it has already returned or thrown.
    if (!finished) {
      try {
        await gen.return?.(undefined as R);
      } catch (err) {
        console.error(
          `[nested-turn] unwinding the nested stream failed: ${(err as Error)?.message}`,
          (err as Error)?.stack?.split("\n").slice(0, 3),
        );
      }
    }
  }
}
