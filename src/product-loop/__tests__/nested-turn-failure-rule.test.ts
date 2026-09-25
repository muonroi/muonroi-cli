/**
 * nested-turn-failure-rule.test.ts — "this nested turn failed" has exactly ONE
 * definition, and both kinds of consumer read it.
 *
 * `forwardNestedTurn` FORWARDS a nested stream upward; the two verify agents
 * (`product-loop/sprint-runner.buildVerifyAgent`,
 * `maintain/task-runner.buildVerifyAgent`) COLLECT it into a payload instead.
 * The collecting shape was written with its own loop that kept only `content`
 * chunks, so it had no failure rule at all and reported `{success:true}` over a
 * turn the watchdog had killed. A second, hand-written copy of the rule would
 * drift the same way, so the rule lives in one place and both helpers share it.
 *
 * These cases pin that the two helpers agree, chunk-script for chunk-script.
 */

import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { collectNestedTurn, forwardNestedTurn } from "../nested-turn.js";

const WATCHDOG_ERROR = {
  type: "error",
  content: "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung",
} as unknown as StreamChunk;
const DONE = { type: "done" } as unknown as StreamChunk;
const text = (s: string) => ({ type: "content", content: s }) as unknown as StreamChunk;

function scripted(chunks: StreamChunk[]): AsyncGenerator<StreamChunk, void, unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

async function viaForward(chunks: StreamChunk[]): Promise<{ output: string; failure: string | null }> {
  let output = "";
  const gen = forwardNestedTurn(scripted(chunks));
  let step = await gen.next();
  while (!step.done) {
    const c = step.value;
    if (c.type === "content" && typeof c.content === "string") output += c.content;
    step = await gen.next();
  }
  return { output, failure: step.value.failure };
}

/** Each case: the nested turn's chunk script, and whether it counts as failed. */
const CASES: Array<{ name: string; script: StreamChunk[]; failed: boolean }> = [
  { name: "normal completion (content, done)", script: [text("a"), DONE], failed: false },
  { name: "watchdog kill (content, error, done)", script: [text("a"), WATCHDOG_ERROR, DONE], failed: true },
  { name: "error as the very last chunk, no done", script: [text("a"), WATCHDOG_ERROR], failed: true },
  { name: "error only, then done", script: [WATCHDOG_ERROR, DONE], failed: true },
  { name: "recovered error (error, content, done)", script: [WATCHDOG_ERROR, text("b"), DONE], failed: false },
  { name: "recovered error, stream just ends after content", script: [WATCHDOG_ERROR, text("b")], failed: false },
  { name: "empty stream", script: [], failed: false },
];

describe("nested-turn — one failure rule, shared by the forwarding and collecting consumers", () => {
  for (const c of CASES) {
    it(`${c.name} → failed=${c.failed}, same for both helpers`, async () => {
      const collected = await collectNestedTurn(scripted(c.script));
      const forwarded = await viaForward(c.script);

      expect(collected.failure !== null).toBe(c.failed);
      expect(forwarded.failure !== null).toBe(c.failed);
      // Same verdict AND same text — one rule, not two that happen to agree.
      expect(collected.failure).toBe(forwarded.failure);
      // Both see the same user-visible text; `done`/`error` never land in it.
      expect(collected.output).toBe(forwarded.output);
    });
  }

  it("carries the failure's own message, so the caller can say WHY", async () => {
    const collected = await collectNestedTurn(scripted([text("a"), WATCHDOG_ERROR, DONE]));
    expect(collected.failure).toContain("Turn ended by watchdog");
  });

  it("an error chunk with no message still counts as a failure", async () => {
    const bare = { type: "error" } as unknown as StreamChunk;
    const collected = await collectNestedTurn(scripted([bare, DONE]));
    expect(collected.failure).toBe("nested turn ended with an error chunk that carried no message");
  });

  it("collects only `content` text — `done` and `error` chunks never reach the payload", async () => {
    const collected = await collectNestedTurn(scripted([text("one "), WATCHDOG_ERROR, text("two"), DONE]));
    expect(collected.output).toBe("one two");
  });

  it("a throw from the nested generator propagates — the caller's finally still runs", async () => {
    const boom = new Error("stream died mid-turn");
    const gen = (async function* () {
      yield text("a");
      throw boom;
    })();
    await expect(collectNestedTurn(gen)).rejects.toThrow("stream died mid-turn");
  });
});

/**
 * The activity signal a collecting consumer can use as LIVENESS.
 *
 * `sprint-runner.buildVerifyAgent` feeds this into the verify stage's silence
 * watchdog, so which chunks count is a correctness question, not a cosmetic one:
 * count too few and a working child looks hung (the `muc2joffe506` defect); count
 * too many and a chattering child looks alive (the defeat recorded on
 * `withImplIdleWatchdog`, where non-progress chunks held an idle timer open 9+ min).
 */
describe("collectNestedTurn — the forward-progress activity signal", () => {
  const toolCall = (...names: string[]) =>
    ({
      type: "tool_calls",
      toolCalls: names.map((n) => ({ id: `id-${n}`, type: "function", function: { name: n, arguments: "{}" } })),
    }) as unknown as StreamChunk;

  async function activityFor(chunks: StreamChunk[]): Promise<string[]> {
    const seen: string[] = [];
    await collectNestedTurn(scripted(chunks), { onActivity: (d) => seen.push(d) });
    return seen;
  }

  it("names the tools a tool_calls chunk committed to", async () => {
    expect(await activityFor([toolCall("bash"), DONE])).toEqual(["verify sub-agent tool call: bash"]);
    expect(await activityFor([toolCall("read_file", "bash"), DONE])).toEqual([
      "verify sub-agent tool call: read_file, bash",
    ]);
  });

  it("reports a tool result, and says when it failed", async () => {
    const ok = { type: "tool_result", toolResult: { success: true, output: "" } } as unknown as StreamChunk;
    const bad = { type: "tool_result", toolResult: { success: false, output: "" } } as unknown as StreamChunk;
    expect(await activityFor([ok, bad, DONE])).toEqual([
      "verify sub-agent tool result",
      "verify sub-agent tool result (failed)",
    ]);
  });

  it("does NOT fire for chunks a turn can emit while advancing nothing", async () => {
    // Every one of these is something a stalled turn keeps producing. If any of
    // them re-armed the silence budget, a hung verify would never be cut.
    const chatter: StreamChunk[] = [
      text("thinking out loud"),
      { type: "toast", content: "still working…" } as unknown as StreamChunk,
      { type: "task_list_update" } as unknown as StreamChunk,
      { type: "reasoning", content: "hmm" } as unknown as StreamChunk,
      { type: "product_status_card" } as unknown as StreamChunk,
      { type: "council_status" } as unknown as StreamChunk,
      WATCHDOG_ERROR,
      DONE,
    ];
    expect(await activityFor(chatter)).toEqual([]);
  });

  it("carries no tool ARGUMENTS — the detail is quoted into a run artifact", async () => {
    const secret = {
      type: "tool_calls",
      toolCalls: [{ id: "x", type: "function", function: { name: "bash", arguments: '{"command":"echo HUNTER2"}' } }],
    } as unknown as StreamChunk;
    const seen = await activityFor([secret, DONE]);
    expect(seen).toEqual(["verify sub-agent tool call: bash"]);
    expect(seen.join(" ")).not.toContain("HUNTER2");
  });

  it("a listener that throws never ends the turn it is watching", async () => {
    const collected = await collectNestedTurn(scripted([toolCall("bash"), text("payload"), DONE]), {
      onActivity: () => {
        throw new Error("listener blew up");
      },
    });
    expect(collected.output).toBe("payload");
    expect(collected.failure).toBeNull();
  });

  it("is inert when no listener is supplied — the pre-existing call shape is unchanged", async () => {
    const collected = await collectNestedTurn(scripted([toolCall("bash"), text("payload"), DONE]));
    expect(collected.output).toBe("payload");
    expect(collected.failure).toBeNull();
  });
});

/**
 * Cancellation. `verify/orchestrator.ts:164` passes an `abortSignal` as the THIRD
 * argument to `runTaskRequest`, and `sprint-runner.buildVerifyAgent` dropped it
 * alongside the second — so when the verify watchdog called `controller.abort()`
 * nothing stopped this loop. Run `muc2joffe506` sprint 1: the abandoned child
 * logged 125 more rows and worked ~10 min past the abandonment.
 *
 * There is no `AbortSignal` parameter anywhere below this seam
 * (`processMessageFn` / `Orchestrator.processMessage` take none), so the signal is
 * honoured by UNWINDING the stream — `gen.return()` at the child's suspended
 * `yield`, which runs its `finally`.
 */
describe("collectNestedTurn — cancellation unwinds the child", () => {
  /** A child that keeps yielding forever, and records whether it was unwound. */
  function endlessChild(state: { unwound: boolean; chunks: number }) {
    return (async function* () {
      try {
        for (;;) {
          state.chunks++;
          yield text("tick ");
          await new Promise((r) => setTimeout(r, 1));
        }
      } finally {
        state.unwound = true;
      }
    })();
  }

  it("stops collecting and unwinds the child when the signal fires mid-stream", async () => {
    const state = { unwound: false, chunks: 0 };
    const ac = new AbortController();
    const p = collectNestedTurn(endlessChild(state), { abortSignal: ac.signal });
    // Let it stream a little, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    const atAbort = state.chunks;
    expect(atAbort).toBeGreaterThan(0);
    ac.abort();

    const collected = await p;
    // It returned instead of collecting forever.
    expect(collected.output.length).toBeGreaterThan(0);
    // The child's `finally` ran — it was told to stop, not merely abandoned.
    await new Promise((r) => setTimeout(r, 20));
    expect(state.unwound).toBe(true);
    // And it did not keep working after the unwind.
    const afterUnwind = state.chunks;
    await new Promise((r) => setTimeout(r, 60));
    expect(state.chunks).toBe(afterUnwind);
  });

  it("reports a cancelled turn as FAILED — a truncated payload never reads as finished", async () => {
    const state = { unwound: false, chunks: 0 };
    const ac = new AbortController();
    const p = collectNestedTurn(endlessChild(state), { abortSignal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    const collected = await p;
    expect(collected.failure).toBe("nested turn was cancelled before it finished; payload is truncated");
  });

  it("cuts a child that is HUNG — producing nothing, so a loop-top check would never run", async () => {
    // The population that matters: the signal must race `next()`, not be polled
    // between chunks. A `for await` here would sit in `next()` forever.
    let unwound = false;
    const hung = (async function* (): AsyncGenerator<StreamChunk, void, unknown> {
      try {
        yield text("started");
        await new Promise<void>(() => {}); // never resolves
      } finally {
        unwound = true;
      }
    })();
    const ac = new AbortController();
    const p = collectNestedTurn(hung, { abortSignal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    const collected = await p; // must not hang
    expect(collected.output).toBe("started");
    expect(collected.failure).toContain("cancelled before it finished");
    // `return()` on a child parked in an un-resolving await cannot complete — it
    // queues behind that call. Not awaiting it is exactly why the caller got its
    // answer anyway; asserting the opposite would pin a false promise.
    expect(unwound).toBe(false);
  });

  it("does NOT abort a child that already returned — a late signal is a no-op", async () => {
    let unwoundAfterDone = false;
    const gen = (async function* (): AsyncGenerator<StreamChunk, void, unknown> {
      try {
        yield text("all done");
        // Generator completes normally here.
      } finally {
        // Runs as part of normal completion; flip only if asked to return AFTER.
      }
    })();
    const realReturn = gen.return?.bind(gen);
    gen.return = ((v?: unknown) => {
      unwoundAfterDone = true;
      return realReturn ? realReturn(v as never) : Promise.resolve({ done: true, value: undefined });
      // biome-ignore lint/suspicious/noExplicitAny: test spy on the iterator protocol
    }) as any;

    const ac = new AbortController();
    const collected = await collectNestedTurn(gen, { abortSignal: ac.signal });
    expect(collected.output).toBe("all done");
    expect(collected.failure).toBeNull();
    // The turn finished on its own, so nothing was cancelled...
    expect(unwoundAfterDone).toBe(false);

    // ...and a signal that fires afterwards changes nothing.
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(unwoundAfterDone).toBe(false);
  });

  it("an already-aborted signal stops before consuming anything", async () => {
    const state = { unwound: false, chunks: 0 };
    const ac = new AbortController();
    ac.abort();
    const collected = await collectNestedTurn(endlessChild(state), { abortSignal: ac.signal });
    expect(collected.output).toBe("");
    expect(collected.failure).toContain("cancelled before it finished");
  });

  it("without a signal the pre-existing behaviour is byte-identical", async () => {
    const collected = await collectNestedTurn(scripted([text("one "), WATCHDOG_ERROR, text("two"), DONE]));
    expect(collected.output).toBe("one two");
    expect(collected.failure).toBeNull();
  });
});
