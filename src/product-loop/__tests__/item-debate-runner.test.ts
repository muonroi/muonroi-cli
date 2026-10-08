/**
 * item-debate-runner.test.ts — direct unit coverage of `runItemDebate` and
 * `combineSignals`, independent of the full `sprint-runner.ts` wiring
 * (`sprint-runner-item-debate.test.ts` covers that seam).
 *
 * Focus: the deadline/abort handling this module owns directly. Since D3
 * (`createProductLlm` now forwards its `signal` param instead of dropping it
 * — see the comment at the ruling-call site in `item-debate-runner.ts`), a
 * call already in flight when the deadline fires CAN be cancelled through the
 * underlying provider call; this module's OWN responsibility is unchanged —
 * stop issuing NEW calls once the budget is gone, and never start work at all
 * against a signal that is already dead.
 */

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCouncil } from "../../council/index.js";
import type { ItemDebateFocus } from "../../council/types.js";
import {
  combineSignals,
  DEFAULT_ITEM_DEBATE_DEADLINE_MS,
  getItemDebateDeadlineMs,
  getItemDebateRulingReserveMs,
  runItemDebate,
} from "../item-debate-runner.js";
import type { SprintPlanArtifact } from "../sprint-plan-artifact.js";

function makePlanWithVagueTask(): SprintPlanArtifact {
  return {
    version: 1,
    sprintN: 1,
    runId: "run-idr-test",
    planHash: "deadbeef",
    source: "structured",
    outcome: { goal: "ship it", acceptance: [] },
    tasks: [
      {
        id: "step1",
        title: "Wire the endpoint",
        doneCriterion: "",
        dependsOn: [],
        targetFiles: [],
        targetDirs: [],
        status: "pending",
      },
    ],
    notes: [],
  };
}

/** N vague-criterion tasks (each empty `doneCriterion`), so `selectDebatableItems`
 * selects all of them (up to the cap) — used by the reserve-budget tests below,
 * which need a known, multi-item `selected.length`. */
function makePlanWithNVagueTasks(n: number): SprintPlanArtifact {
  return {
    version: 1,
    sprintN: 1,
    runId: "run-idr-test",
    planHash: "deadbeef",
    source: "structured",
    outcome: { goal: "ship it", acceptance: [] },
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `step${i + 1}`,
      title: `Wire endpoint ${i + 1}`,
      doneCriterion: "",
      dependsOn: [],
      targetFiles: [],
      targetDirs: [],
      status: "pending" as const,
    })),
    notes: [],
  };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    plan: makePlanWithVagueTask(),
    councilTopic: "argue the plan",
    sessionModelId: "test-model",
    runId: "run-idr-test",
    cwd: "/tmp/cwd-idr",
    runDir: "/tmp/cwd-idr/.muonroi-flow/runs/run-idr-test",
    llm: { generate: vi.fn(async () => "default reply"), research: vi.fn(async () => "") },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "..." };
    }),
    ...overrides,
  } as unknown as Parameters<typeof runItemDebate>[0];
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R> {
  let last: IteratorResult<T, R>;
  do {
    last = await gen.next();
  } while (!last.done);
  return last.value;
}

const ORIGINAL_DEADLINE_ENV = process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
const ORIGINAL_RESERVE_ENV = process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE;
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS;
});

afterEach(() => {
  if (ORIGINAL_DEADLINE_ENV === undefined) delete process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
  else process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = ORIGINAL_DEADLINE_ENV;
  if (ORIGINAL_RESERVE_ENV === undefined) delete process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS;
  else process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = ORIGINAL_RESERVE_ENV;
});

describe("getItemDebateDeadlineMs", () => {
  it("returns the default when unset", () => {
    expect(getItemDebateDeadlineMs()).toBe(DEFAULT_ITEM_DEBATE_DEADLINE_MS);
  });

  it("honours a valid override", () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "5000";
    expect(getItemDebateDeadlineMs()).toBe(5000);
  });

  it("ignores an invalid override and logs why", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "not-a-number";
    expect(getItemDebateDeadlineMs()).toBe(DEFAULT_ITEM_DEBATE_DEADLINE_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

/**
 * D8-followup — the reserve `runItemDebate` carves out of the total BEFORE
 * the scoped debate starts, so a debate that consumes its own share never
 * gets to eat the rulings' time too (the exact failure mu75rurpf9ec hit:
 * 100% no_verdict because the debate spent the WHOLE 600_000ms total).
 */
describe("getItemDebateRulingReserveMs", () => {
  it("computes min(itemCount * perItemMs, totalMs * fraction) when unset", () => {
    // 3 items * 60_000ms = 180_000; 900_000 * 0.3 = 270_000 -> min = 180_000.
    expect(getItemDebateRulingReserveMs(3, 900_000)).toBe(180_000);
  });

  it("the fraction cap binds when itemCount is large (protects the debate's share from a big override)", () => {
    // 20 items * 60_000ms = 1_200_000; 900_000 * 0.3 = 270_000 -> min = 270_000.
    expect(getItemDebateRulingReserveMs(20, 900_000)).toBe(270_000);
  });

  it("honours a valid override, ignoring itemCount/totalMs entirely", () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "12345";
    expect(getItemDebateRulingReserveMs(3, 900_000)).toBe(12345);
  });

  it("0 is a valid, meaningful override (no protected reserve)", () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "0";
    expect(getItemDebateRulingReserveMs(3, 900_000)).toBe(0);
  });

  it("ignores an invalid override and logs why, falling back to the computed default", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "not-a-number";
    expect(getItemDebateRulingReserveMs(3, 900_000)).toBe(180_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("a negative override is invalid (reserve is never negative) and falls back", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "-5";
    expect(getItemDebateRulingReserveMs(3, 900_000)).toBe(180_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("combineSignals", () => {
  it("returns a signal that is not aborted when neither input is", () => {
    const b = new AbortController().signal;
    const combined = combineSignals(undefined, b);
    expect(combined.aborted).toBe(false);
  });

  it("aborts when `a` aborts", () => {
    const ac = new AbortController();
    const b = new AbortController().signal;
    const combined = combineSignals(ac.signal, b);
    expect(combined.aborted).toBe(false);
    ac.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when `b` aborts", () => {
    const ac = new AbortController();
    const a = new AbortController().signal;
    const combined = combineSignals(a, ac.signal);
    expect(combined.aborted).toBe(false);
    ac.abort();
    expect(combined.aborted).toBe(true);
  });

  it("is immediately aborted when `a` is already aborted before combining", () => {
    const ac = new AbortController();
    ac.abort();
    const b = new AbortController().signal;
    expect(combineSignals(ac.signal, b).aborted).toBe(true);
  });

  it("is immediately aborted when `b` is already aborted before combining", () => {
    const ac = new AbortController();
    ac.abort();
    expect(combineSignals(undefined, ac.signal).aborted).toBe(true);
  });
});

describe("runItemDebate", () => {
  it("an already-aborted caller signal skips the work honestly, without calling runCouncil", async () => {
    const controller = new AbortController();
    controller.abort();
    const args = baseArgs({ abortSignal: controller.signal });

    const result = await drain(runItemDebate(args));

    expect(runCouncil).not.toHaveBeenCalled();
    expect(result.triggered).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("already aborted");
    expect(result.items).toEqual([]);
  });

  it("the deadline trips before ruling calls: every selected item records an honest no_verdict, and no ruling call is made", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "1"; // 1ms — expires almost immediately
    const generate = vi.fn(async () => JSON.stringify({ ruling: "should never be seen", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });

    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
    ) {
      // Outlast the 1ms deadline before returning, so by the time the ruling
      // loop below runs, `signal.aborted` is already true.
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });

    const result = await drain(runItemDebate(args));

    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.leaderRuling).toBe("no_verdict");
      expect(item.changeKind).toBe("none");
    }
    // The deadline stopped the loop from ever ASKING for a ruling — this is
    // not "the model declined", it is "no call was made at all".
    expect(generate).not.toHaveBeenCalled();
  });

  it("D3: an aborted ruling call surfaces as an honest no_verdict, not a thrown error", async () => {
    // Regression guard for the fix documented at the ruling-call site: once
    // `createProductLlm.generate` forwards its signal, a ruling call can now
    // actually reject with an AbortError (Esc, or the item-debate's own
    // deadline firing mid-call). `requestItemRuling`'s own catch (item-
    // debate-runner.ts) must still absorb that into `leaderRuling: "no_verdict"`
    // rather than letting it escape and crash the whole sprint.
    const generate = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });

    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
    ) {
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });

    const result = await drain(runItemDebate(args));

    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.leaderRuling).toBe("no_verdict");
      expect(item.changeKind).toBe("none");
    }
    // The call WAS attempted this time (unlike the deadline-trip test above) —
    // it just failed, and failed honestly.
    expect(generate).toHaveBeenCalled();
  });

  it("MUONROI_IDEAL_ITEM_DEBATE=0: never calls runCouncil at all", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE = "0";
    const args = baseArgs();
    const result = await drain(runItemDebate(args));
    expect(runCouncil).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(result.stopReason).toBe("disabled");
  });

  it("D6: never calls respondToQuestion, resolves automatically, and surfaces the debate's escalation on the result", async () => {
    // Regression guard for the 38h stall (run mu75rurpf9ec / session
    // f52d9bfc50a2): the scoped debate hit its progress limit with a pinned
    // criterion still unmet. With the council/index.ts fix,
    // `sprintPlanningMode: true` makes `autoAcceptEscalation: true`, so the
    // REAL `runCouncil` never calls `respondToQuestion` and instead threads
    // the auto-resolved outcome back through the shared `councilStats.escalation`
    // (by-reference, same pattern as `stats.calls`) — this test simulates
    // exactly that side effect and proves `runItemDebate` carries it onto its
    // own result untouched, so `sprint-runner.ts` can persist it honestly.
    const respondToQuestion = vi.fn(async () => "escalate_extend");
    const args = baseArgs({ respondToQuestion });

    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[]; councilStats?: { escalation?: unknown } } | undefined,
    ) {
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      // The REAL runCouncil threads this onto the shared stats object
      // (council/index.ts, D6 fix) — never by calling respondToQuestion.
      if (options?.councilStats) {
        options.councilStats.escalation = { action: "accept", auto: true };
      }
      return "debate synthesis";
    });

    const result = await drain(runItemDebate(args));

    expect(respondToQuestion).not.toHaveBeenCalled();
    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.escalation).toEqual({ action: "accept", auto: true });
  });

  /**
   * D8 — the retry mechanics `requestItemRuling`/`runItemDebate` add on top
   * of the C3 parser (`item-debate-record.test.ts` covers the parser
   * directly). These pin: a retry fires exactly once, only when a reply was
   * obtained but unparseable, uses the shorter retry prompt, and a call
   * failure is never retried.
   */
  function mockCouncilWithOneRound() {
    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
    ) {
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });
  }

  it("D8: a first reply that doesn't parse gets ONE retry with the shorter prompt, and the retry's ruling wins", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("Sure, no changes needed here!") // unparseable — no JSON block
      .mockResolvedValueOnce(JSON.stringify({ ruling: "fine as written", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilWithOneRound();

    const result = await drain(runItemDebate(args));

    expect(generate).toHaveBeenCalledTimes(2);
    const [, firstSystem] = generate.mock.calls[0];
    const [, secondSystem] = generate.mock.calls[1];
    expect(firstSystem).toContain("Reply with exactly one JSON object");
    expect(secondSystem).toContain("Your previous reply could not be read as JSON");
    expect(result.items[0]?.leaderRuling).toBe("fine as written");
    expect(result.items[0]?.changeKind).toBe("none");
    expect(result.items[0]?.rulingDebug).toBeUndefined();
  });

  it("D8: still unparseable after the retry -> no_verdict with attempts=2 and the RETRY's own rawTail", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("first bad reply, no json here")
      .mockResolvedValueOnce("second bad reply, still no json");
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilWithOneRound();

    const result = await drain(runItemDebate(args));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.items[0]?.leaderRuling).toBe("no_verdict");
    expect(result.items[0]?.rulingDebug?.attempts).toBe(2);
    expect(result.items[0]?.rulingDebug?.rawTail).toBe("second bad reply, still no json");
  });

  it("D8: a call that itself fails (never returns text) is NOT retried", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilWithOneRound();

    const result = await drain(runItemDebate(args));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.rulingDebug).toEqual({
      reason: "call_error",
      attempts: 1,
      errorDetail: "provider unavailable",
    });
  });

  it("D8: the deadline-skip path records rulingDebug.reason no_call with zero attempts", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "1";
    const generate = vi.fn(async () => JSON.stringify({ ruling: "should never be seen", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });

    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[] } | undefined,
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });

    const result = await drain(runItemDebate(args));

    expect(generate).not.toHaveBeenCalled();
    expect(result.items[0]?.rulingDebug?.reason).toBe("no_call");
    expect(result.items[0]?.rulingDebug?.attempts).toBe(0);
  });
});

/**
 * D8-followup — the total/reserve BUDGET SPLIT: a scoped debate that
 * consumes its own (smaller) share must still leave the rulings runnable,
 * a debate that overruns its own share must NOT be able to eat the
 * reserve, and the overall total must still bound the whole call either
 * way. Root cause this closes: live run `mu75rurpf9ec` gave the debate and
 * the rulings the SAME single deadline, so a debate that used the whole
 * budget left literally zero calls for the ruling loop — every item across
 * both sprints recorded `no_verdict` for that reason alone.
 */
describe("runItemDebate — D8-followup budget split (debate share vs. ruling reserve)", () => {
  function mockCouncilAfterDelay(delayMs: number, respectAbort = false) {
    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[]; signal?: AbortSignal } | undefined,
    ) {
      if (respectAbort && options?.signal) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delayMs);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });
      } else {
        // Deliberately ignores `options.signal` — simulates a debate whose
        // own internal abort handling lags past its allotted share.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });
  }

  it("a debate that consumes most of its own (smaller) share still leaves the rulings runnable, and they produce a ruling", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "300";
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "150"; // debate share = 150ms
    const generate = vi.fn(async () => JSON.stringify({ ruling: "fine as written", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilAfterDelay(140, true); // just under its 150ms share

    const result = await drain(runItemDebate(args));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.leaderRuling).toBe("fine as written");
    expect(result.items[0]?.rulingDebug).toBeUndefined();
  });

  it("a debate that RESPECTS its own smaller share stops early — the reserve is genuinely available, not just 'whatever the debate happened to leave'", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "300";
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "200"; // debate share = 100ms
    const generate = vi.fn(async () => JSON.stringify({ ruling: "fine as written", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });

    const debateStart = Date.now();
    let debateElapsedWhenReturned = 0;
    (runCouncil as any).mockImplementation(async function* (
      _topic: string,
      _sessionModelId: string,
      _messages: unknown[],
      _runId: string,
      _llm: unknown,
      _respondToQuestion: unknown,
      _respondToPreflight: unknown,
      _processMessageFn: unknown,
      options: { perRoundFocus?: readonly ItemDebateFocus[]; signal?: AbortSignal } | undefined,
    ) {
      // WANTS 500ms of work — far more than even the 300ms total — but
      // properly listens for its OWN abort signal, the same way a real
      // debate's internal LLM calls thread the signal through. This is the
      // well-behaved case the split is specifically FOR: giving the debate a
      // smaller nominal budget only matters if a debate that honours its
      // signal actually gets cut there, rather than being allowed to run
      // toward the full total the way a single shared deadline would.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      debateElapsedWhenReturned = Date.now() - debateStart;
      yield {
        type: "council_round",
        councilRound: {
          round: 1,
          state: "done",
          itemId: options?.perRoundFocus?.[0]?.id,
          participants: ["Engineer"],
          pairCount: 1,
          emergent: false,
        },
      };
      return "debate synthesis";
    });

    const result = await drain(runItemDebate(args));

    // Cut at its OWN ~100ms share, not left running toward the 300ms total —
    // proves the debate was actually handed the SMALLER deadline, not the
    // shared one.
    expect(debateElapsedWhenReturned).toBeLessThan(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.leaderRuling).toBe("fine as written");
    expect(result.items[0]?.rulingDebug).toBeUndefined();
  });

  it("a debate that IGNORES its own abort signal entirely still cannot push the ruling window past the fixed total", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "200";
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "100"; // debate share = 100ms
    const generate = vi.fn(async () => JSON.stringify({ ruling: "should never be reached", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilAfterDelay(260, false); // ignores the signal, sleeps past the 200ms total itself

    const result = await drain(runItemDebate(args));

    expect(generate).not.toHaveBeenCalled();
    expect(result.items[0]?.rulingDebug?.reason).toBe("no_call");
  });

  it("the reserve can also be exhausted WITHOUT a debate overrun — later items in the shared pool honestly go no_call once earlier ones spend it", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "200";
    // 3 vague-criterion tasks -> selectDebatableItems selects all 3 (cap 3).
    // Reserve computes to min(3*60_000, 200*0.3) = 60ms here — plenty above
    // the 5ms the debate itself takes below.
    let callIndex = 0;
    const generate = vi.fn(async () => {
      callIndex += 1;
      // A SINGLE call (150ms) safely fits under the 200ms total (45ms
      // margin); TWO of them (300ms) safely exceed it (100ms margin) — wide
      // enough margins on both sides to not flake on scheduler jitter.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return JSON.stringify({ ruling: `ruling ${callIndex}`, changeKind: "none" });
    });
    const args = baseArgs({ plan: makePlanWithNVagueTasks(3), llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilAfterDelay(5, true); // debate itself finishes almost instantly

    const result = await drain(runItemDebate(args));

    expect(result.selected).toHaveLength(3);
    expect(generate).toHaveBeenCalledTimes(2); // items 1 and 2 got a real call
    expect(result.items[0]?.leaderRuling).toBe("ruling 1");
    expect(result.items[1]?.leaderRuling).toBe("ruling 2");
    // Item 3's turn arrives after the shared total is already spent.
    expect(result.items[2]?.rulingDebug?.reason).toBe("no_call");
    expect(result.items[2]?.rulingDebug?.attempts).toBe(0);
  });

  it("the overall total deadline still bounds the whole call — debate share + ruling reserve never add up to more than it", async () => {
    process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = "300";
    process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS = "150";
    const generate = vi.fn(async () => JSON.stringify({ ruling: "fine as written", changeKind: "none" }));
    const args = baseArgs({ llm: { generate, research: vi.fn(async () => "") } });
    mockCouncilAfterDelay(5, true); // fast, well within its 150ms share

    const start = Date.now();
    const result = await drain(runItemDebate(args));
    const elapsed = Date.now() - start;

    expect(result.stopReason).toBe("completed");
    // Generous margin over the 300ms total for scheduler/test jitter — this
    // must stay well clear of "ran for seconds", proving nothing here is
    // unbounded even after splitting one deadline into two.
    expect(elapsed).toBeLessThan(2_000);
  });
});
