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

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE;
  delete process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
});

afterEach(() => {
  if (ORIGINAL_DEADLINE_ENV === undefined) delete process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
  else process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS = ORIGINAL_DEADLINE_ENV;
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
});
