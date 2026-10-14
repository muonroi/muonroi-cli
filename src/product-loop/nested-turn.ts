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
 * THE ONE GATE on what counts as FORWARD PROGRESS: a detail line, or `null` for
 * "this chunk is not progress". Returning `null` is what keeps a chunk out of the
 * liveness signal, so this function is the whole policy — deliberately not a
 * type allowlist plus a formatter, because those two can drift into disagreement
 * and then the allowlist is decorative (it was, in the first draft of this change:
 * widening it to `content`/`toast` changed nothing, because the formatter still
 * returned `null` for them).
 *
 * WHY THE LIST IS SHORT. A consumer's caller may use this as a liveness signal
 * (see `collectNestedTurn`'s `onActivity`), and a per-chunk liveness signal has
 * already been DEFEATED in this codebase: the implementation stage's idle guard
 * was kept alive for 9+ minutes by a turn that "created 2 files then emitted only
 * non-progress heartbeat chunks", resetting the timer without ever completing
 * (`sprint-runner.withImplIdleWatchdog`, which needed a second total-time arm
 * precisely because of it). `content`, `reasoning`, `toast`, `task_list_update`,
 * `product_status_card` and the council card chunks are all things a turn can
 * emit while advancing nothing, so none of them is progress here.
 *
 * A tool call is the narrowest thing that cannot be faked by chattering: the model
 * committed to an action. It is also exactly what the sibling sub-agent path
 * already treats as activity — `stream-runner.ts:1023-1027` fires its `onActivity`
 * on `part.type === "tool-call"` and calls `stall.petProgress()` there under the
 * comment "real forward progress". A tool RESULT joins it because a long single
 * command (a `dotnet test` sweep) reports its completion nowhere else.
 *
 * Tool NAMES only, never arguments. The detail is quoted into the verify stage's
 * timeout message and from there into `sprints/<n>-verify.md`, so arguments would
 * put arbitrary commands and file contents into a run artifact; and it keeps the
 * per-chunk cost to a string concat instead of a `JSON.parse` of every argument
 * blob (`ToolCall.function.arguments` is an unparsed JSON string).
 */
function progressDetail(chunk: StreamChunk): string | null {
  if (chunk.type === "tool_calls") {
    const names = (chunk.toolCalls ?? []).map((c) => c?.function?.name).filter((n): n is string => !!n);
    return `verify sub-agent tool call: ${names.length > 0 ? names.join(", ") : "unnamed"}`;
  }
  if (chunk.type === "tool_result") {
    return `verify sub-agent tool result${chunk.toolResult?.success === false ? " (failed)" : ""}`;
  }
  return null;
}

export interface CollectNestedTurnOptions {
  /**
   * Called once per forward-progress chunk (see `progressDetail`, which is the one
   * gate on what qualifies) with a short detail line.
   *
   * WHY IT EXISTS. `VerifyAgentLike.runTaskRequest` has always DECLARED an
   * `onActivity` parameter and `verify/orchestrator.ts:164` has always passed one,
   * but the `/ideal` implementation (`sprint-runner.buildVerifyAgent`) took only
   * `req` and dropped it — there was no producer, because the nested turn's
   * activity arrives as a chunk stream rather than as a callback. So the verify
   * stage's silence watchdog was measuring the PARENT's own preparation beats: the
   * last thing it ever heard was "Running verify sub-agent", emitted immediately
   * BEFORE the child started, and a healthy child was therefore indistinguishable
   * from a hung one.
   *
   * MEASURED, run `muc2joffe506` sprint 1 (`~/.muonroi-cli/muonroi.db`): parent
   * `2a116648b48e` fell silent at 06:53:40.352Z; child `9f04faf649b3` then logged
   * 302 more rows and kept working until 07:16:30.761Z, 9.7 minutes PAST the
   * 07:06:47 abandonment. The verdict became ERROR, the goal gate declined to run
   * on a non-PASS verdict, criteria scored 0/4, the sprint scored 0 and the run
   * ended `phases-deadlocked` — on a sprint whose deterministic floor had measured
   * build and both test suites green.
   *
   * Never throws into the stream: a listener fault must not kill the turn it is
   * only observing.
   */
  onActivity?: (detail: string) => void;
  /**
   * Cancellation for the nested turn. When it fires, collection stops and the
   * nested generator is UNWOUND, so the child stops instead of running on
   * un-awaited.
   *
   * WHY IT IS HONOURED HERE AND NOT PASSED DOWNWARD. `DriverContext.processMessageFn`
   * is `(message: string) => AsyncGenerator<...>` (types.ts:164) and
   * `Orchestrator.processMessage` is `(userMessage, observer?, images?)`
   * (orchestrator.ts:3567) — neither takes an `AbortSignal`, so there is no
   * parameter to thread one into. Its sibling `runIsolatedTask` DOES take one
   * (types.ts:185), which is why the isolated implementation stage can cancel its
   * child and this path could not.
   *
   * What IS available is the async-iteration protocol: ceasing to iterate calls
   * `gen.return()`, which unwinds the child at its suspended `yield` and runs its
   * `finally` blocks (the write-mutex release and permission-mode restore that
   * `forwardNestedTurn` documents relying on). MEASURED on both shapes — a child
   * parked at a `yield` and a child about to enter a 20-await tool call — the
   * child's `finally` ran and it performed ZERO further units of work.
   *
   * THE SIGNAL MUST RACE `next()`, not be checked at the loop top. A loop-top
   * check is only reached when the next chunk arrives, so on the case that matters
   * most — a child producing NOTHING — it would never fire. Racing is the same
   * shape `sprint-runner.withImplIdleWatchdog` uses against its idle timer.
   *
   * MEASURED DEFECT this closes, run `muc2joffe506` sprint 1: `runVerifyWithWatchdog`
   * called `controller.abort()` on timeout, the signal reached
   * `agent.runTaskRequest` as its third argument, and the implementation dropped it
   * — so nothing ever stopped this loop. The child logged 125 more rows and worked
   * until 07:16:30.761Z, ~10 minutes past the 07:06:47 abandonment, and
   * `sprints/1-verify.md` recorded the consequence in its own words: "it may still
   * be running when this returned".
   */
  abortSignal?: AbortSignal;
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
  opts?: CollectNestedTurnOptions,
): Promise<CollectedNestedTurn> {
  const tracker = createNestedTurnFailureTracker();
  const onActivity = opts?.onActivity;
  const signal = opts?.abortSignal;
  // Explicit iteration rather than `for await` so the abort can race `next()`
  // (see `CollectNestedTurnOptions.abortSignal`). Unwinding is preserved below:
  // `for await` calls `gen.return()` on an early exit, and so does the `finally`.
  const it = gen[Symbol.asyncIterator]();
  // ONE listener for the whole turn. Registering it per iteration would add a
  // listener per chunk — 569 of them on a measured verify stage — and leak until
  // the signal fired.
  const ABORTED = Symbol("aborted");
  const abortPromise: Promise<typeof ABORTED> | null = signal
    ? new Promise((resolve) => {
        if (signal.aborted) {
          resolve(ABORTED);
          return;
        }
        signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      })
    : null;
  let output = "";
  let aborted = false;
  let finished = false;
  try {
    for (;;) {
      const step = abortPromise ? await Promise.race([it.next(), abortPromise]) : await it.next();
      if (step === ABORTED) {
        aborted = true;
        break;
      }
      if (step.done) {
        finished = true;
        break;
      }
      const chunk = step.value;
      tracker.observe(chunk);
      const detail = onActivity && chunk ? progressDetail(chunk) : null;
      if (onActivity && detail !== null) {
        try {
          onActivity(detail);
        } catch (err) {
          // No-Silent-Catch: reported, but never rethrown into the stream. This
          // listener only WATCHES the turn; a fault in it must not end the turn.
          console.error(
            `[nested-turn] an activity listener threw on a ${chunk?.type} chunk: ${(err as Error)?.message}`,
            (err as Error)?.stack?.split("\n").slice(0, 3),
          );
        }
      }
      if (chunk?.type === "content" && typeof chunk.content === "string") {
        output += chunk.content;
      }
    }
  } finally {
    // Unwind the child unless it already ran to completion — the same thing a
    // `for await`'s early exit does, and what `forwardNestedTurn`'s `finally`
    // documents. NOT awaited: a child hung inside `next()` queues its `return()`
    // behind that pending call, so awaiting it here would hand the caller the very
    // unbounded wait the abort exists to end. Its rejection is still observed.
    if (!finished) {
      try {
        void Promise.resolve(it.return?.(undefined)).catch((err: unknown) => {
          console.error(
            `[nested-turn] unwinding the aborted nested stream failed: ${(err as Error)?.message}`,
            (err as Error)?.stack?.split("\n").slice(0, 3),
          );
        });
      } catch (err) {
        console.error(`[nested-turn] calling return() on the nested stream threw: ${(err as Error)?.message}`);
      }
    }
  }
  // A cancelled turn's payload is TRUNCATED, and this file's whole reason for
  // existing is that a truncated payload must never read as a finished one (the
  // collecting consumers used to return `{success:true}` over a watchdog kill and
  // `parseVerifyResult` scored the sprint on it). An abort carries no `error`
  // chunk, so say so explicitly rather than letting `failure` stay null.
  const failure = aborted
    ? (tracker.end() ?? "nested turn was cancelled before it finished; payload is truncated")
    : tracker.end();
  return { output, failure };
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
