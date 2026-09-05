/**
 * ideal-abort-propagation.test.ts — P0-4 remainder.
 *
 * Phase 0 fixed the Escape GUARD: `interruptActiveRun` now re-arms
 * `isProcessingRef` on the detached `/ideal` dispatch, so the keypress reaches
 * `agent.abort()` (pinned by `src/ui/__tests__/detached-slash-interrupt.test.ts`).
 * The abort still did nothing, for two independent reasons — both measured by
 * reading the code, both reproduced below:
 *
 *  1. `Agent.abort()` is `this.abortController?.abort()` (orchestrator.ts:882).
 *     `runCouncilV2` creates that controller when none exists (:2183-2187,
 *     added for exactly this bug on the `/council` path). `runProductLoopV1`
 *     never did — and the `/ideal` SLASH path does NOT run inside
 *     `processMessage` (the only other site that sets it, :4262), because the
 *     TUI calls `agent.runProductLoopV1(payload)` directly. So on `/ideal`,
 *     `abort()` hit a null controller: a total no-op.
 *
 *  2. Even with a controller, nothing in the product loop passes a signal to a
 *     model call. Every `llm.generate(...)` site (loop-driver, sprint-planner,
 *     done-gate, gather, backlog-builder, criteria-seed, cross-run-memory,
 *     assumption-ledger) omits it; `runDebate(spec, config, ctx.llm)` is built
 *     with a config that has no `signal` field (loop-driver.ts:761) even though
 *     `debate.ts:692` reads one; and the sprint-planning `runCouncil` is called
 *     with no `options.signal` (sprint-runner.ts:821).
 *
 * The fix reuses the council's existing one-place injector, `withCouncilSignal`
 * (council/index.ts:86) — the same machinery the `/council` path already uses —
 * extended to `debate`/`research` because those are unthreaded on the `/ideal`
 * path only.
 *
 * The fake product loop below models a council call the way a real hung
 * provider call behaves: it returns only when its abort signal fires. With no
 * signal it cannot return at all — which is precisely the uncancellable turn.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RecordedCall = { kind: "generate" | "debate" | "research"; signal?: AbortSignal };

const state: {
  mode: "hang-in-council" | "swallow-abort" | "debate-call";
  recorded: RecordedCall[];
  releaseHatch: null | (() => void);
} = { mode: "hang-in-council", recorded: [], releaseHatch: null };

/**
 * Model a pending provider call: settle only when the abort signal fires. With
 * NO signal there is nothing to wait on — park on a hatch the test releases in
 * afterEach so the negative control fails on its assertion rather than hanging
 * the whole suite.
 */
function blockUntilAborted(signal?: AbortSignal): Promise<boolean> {
  if (!signal) return new Promise<boolean>((resolve) => (state.releaseHatch = () => resolve(false)));
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true }));
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

vi.mock("../../council/llm.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createCouncilLLM: () => ({
    generate: async (
      _modelId: string,
      _system: string,
      _prompt: string,
      _maxTokens?: number,
      _onUsage?: unknown,
      signal?: AbortSignal,
    ) => {
      state.recorded.push({ kind: "generate", signal });
      // Only an abort ends a pending provider call. The `false` branch is the
      // test-owned hatch that exists purely so a signal-less (i.e. broken)
      // wiring fails on an assertion instead of hanging the suite.
      if (await blockUntilAborted(signal)) throw abortError();
      return "";
    },
    debate: async (_modelId: string, _system: string, _prompt: string, signal?: AbortSignal) => {
      state.recorded.push({ kind: "debate", signal });
      return { text: "", toolCalls: [] };
    },
    research: async (_modelId: string, _topic: string, _ctx: string, signal?: AbortSignal) => {
      state.recorded.push({ kind: "research", signal });
      return "";
    },
  }),
}));

vi.mock("../../product-loop/index.js", () => ({
  runProductLoop: (opts: { llm: Record<string, (...args: never[]) => Promise<unknown>> }) =>
    (async function* () {
      yield { type: "content", content: "phase 1" };
      if (state.mode === "debate-call") {
        // loop-driver.ts:761 shape — runDebate is handed ctx.llm and a config
        // with no `signal`, so llm.debate receives undefined for its 4th arg.
        await opts.llm.debate(...(["m", "sys", "prompt"] as never[]));
        yield { type: "content", content: "phase 2" };
        return;
      }
      if (state.mode === "swallow-abort") {
        // Every product-loop phase is fail-open: an AbortError from the model
        // call is swallowed and the loop marches on to the next phase.
        await opts.llm.generate(...(["m", "sys", "prompt"] as never[])).catch(() => undefined);
        yield { type: "content", content: "phase 2" };
        yield { type: "content", content: "phase 3" };
        return;
      }
      await opts.llm.generate(...(["m", "sys", "prompt"] as never[]));
      yield { type: "content", content: "phase 2" };
    })(),
}));

import { withCouncilSignal } from "../../council/index.js";
import type { CouncilLLM } from "../../council/types.js";
import { loadCatalog } from "../../models/registry.js";
import { Agent } from "../orchestrator.js";

const STATUS_PAYLOAD = {
  subcommand: "status" as const,
  flags: { maxCost: 1, maxSprints: 1, doneThreshold: 0.9 },
};

function makeAgent(): Agent {
  return new Agent("sk-test", undefined, "glm-4.7", undefined, { persistSession: false });
}

/** Poll until `pred()` or the budget expires; throws with context on timeout. */
async function waitUntil(pred: () => boolean, label: string, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("runProductLoopV1 — Escape's abort must reach a pending council (P0-4)", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    process.env.MUONROI_TEST_NO_PERSIST = "1";
    process.env.MUONROI_TEST_NO_KEYCHAIN = "1";
    state.mode = "hang-in-council";
    state.recorded = [];
    state.releaseHatch = null;
  });

  afterEach(() => {
    delete process.env.MUONROI_TEST_NO_PERSIST;
    delete process.env.MUONROI_TEST_NO_KEYCHAIN;
    // Unpark a fake call that never got a signal (pre-fix shape) so a failing
    // assertion doesn't leave the generator suspended forever.
    state.releaseHatch?.();
    state.releaseHatch = null;
  });

  it("hands the council a live signal that agent.abort() actually aborts", async () => {
    const agent = makeAgent();
    const gen = agent.runProductLoopV1(STATUS_PAYLOAD);

    expect((await gen.next()).value).toMatchObject({ type: "content", content: "phase 1" });

    const pending = gen.next(); // enters the council call and blocks there
    await waitUntil(() => state.recorded.length === 1, "the product loop to reach a council call");

    const seen = state.recorded[0].signal;
    expect(
      seen,
      "the /ideal path handed the council NO abort signal — agent.abort() cannot reach a pending council",
    ).toBeDefined();
    expect(seen?.aborted, "signal must still be live before the user presses Escape").toBe(false);

    agent.abort(); // ← what interruptActiveRun does on Escape

    expect(seen?.aborted, "agent.abort() did not abort the signal the council is waiting on").toBe(true);
    // …and the turn actually ends rather than staying wedged.
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("stops the loop at the next phase boundary when a phase swallows the AbortError", async () => {
    state.mode = "swallow-abort";
    const agent = makeAgent();
    const gen = agent.runProductLoopV1(STATUS_PAYLOAD);

    await gen.next(); // phase 1
    const pending = gen.next();
    await waitUntil(() => state.recorded.length === 1, "the product loop to reach a council call");

    agent.abort();

    // The phase swallowed the abort and yielded its next chunk…
    expect((await pending).value).toMatchObject({ content: "phase 2" });
    // …but the run must not continue into phase 3.
    expect(await gen.next()).toMatchObject({ done: true });
  });

  it("releases the controller it created so a later turn starts clean", async () => {
    const agent = makeAgent();
    const gen = agent.runProductLoopV1(STATUS_PAYLOAD);
    await gen.next();
    await gen.return(undefined as never);

    // A second run must get a FRESH live signal, not the aborted/stale one.
    state.recorded = [];
    const gen2 = agent.runProductLoopV1(STATUS_PAYLOAD);
    await gen2.next();
    const pending = gen2.next();
    await waitUntil(() => state.recorded.length === 1, "the second run to reach a council call");
    expect(state.recorded[0].signal?.aborted).toBe(false);

    agent.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("injects the signal into debate too — /ideal's runDebate config carries none", async () => {
    state.mode = "debate-call";
    const agent = makeAgent();
    const gen = agent.runProductLoopV1(STATUS_PAYLOAD);
    await gen.next();
    await gen.next();

    const call = state.recorded.find((c) => c.kind === "debate");
    expect(call, "the product loop never reached llm.debate").toBeDefined();
    expect(call?.signal, "llm.debate got no abort signal on the /ideal path").toBeDefined();
    agent.abort();
    expect(call?.signal?.aborted).toBe(true);
  });
});

describe("withCouncilSignal — debate/research injection (the /ideal-only gap)", () => {
  function recordingLlm() {
    const calls: RecordedCall[] = [];
    const llm: CouncilLLM = {
      generate: async (_m, _s, _p, _mt, _u, signal) => {
        calls.push({ kind: "generate", signal });
        return "{}";
      },
      debate: async (_m, _s, _p, signal) => {
        calls.push({ kind: "debate", signal });
        return { text: "ok", toolCalls: [] };
      },
      research: async (_m, _t, _c, signal) => {
        calls.push({ kind: "research", signal });
        return "findings";
      },
    };
    return { llm, calls };
  }

  it("injects into debate and research when the caller passes none", async () => {
    const { llm, calls } = recordingLlm();
    const ac = new AbortController();
    const wrapped = withCouncilSignal(llm, ac.signal);

    await wrapped.debate("m", "sys", "prompt");
    await wrapped.research("m", "topic", "ctx");

    expect(calls.map((c) => c.signal)).toEqual([ac.signal, ac.signal]);
  });

  it("lets an explicit per-call signal win (runCouncil already threads one)", async () => {
    const { llm, calls } = recordingLlm();
    const injected = new AbortController().signal;
    const explicit = new AbortController().signal;
    const wrapped = withCouncilSignal(llm, injected);

    await wrapped.debate("m", "sys", "prompt", explicit);
    await wrapped.research("m", "topic", "ctx", explicit);

    expect(calls.map((c) => c.signal)).toEqual([explicit, explicit]);
  });
});
