/**
 * product-loop-pause-release.test.ts — P0-1 regression.
 *
 * `/ideal` (`Agent.runProductLoopV1`) hands the product loop the SAME
 * `createQuestionResponder` / `createPreflightResponder` closures the council
 * uses, and those bracket every open card with `beginInteractivePause()`
 * (council-manager.ts `holdWatchdogOpen`). A card that is never answered — the
 * user hits Esc, the TUI breaks out of its `for await` (which unwinds this
 * generator via `gen.return()`), or the loop throws while a card is open — never
 * resolves, so its pause leaks.
 *
 * `pauseDepth` is PROCESS-GLOBAL. One leak permanently satisfies
 * `shouldSuppressFire` for the top-level turn watchdog (orchestrator.ts:3568)
 * and the provider stall watchdog (tool-engine.ts:1977), so every LATER chat
 * turn in the process is un-guarded — a stalled turn can then hang forever.
 *
 * `runCouncilV2` already had the `finally { releasePendingWaits() }` guard;
 * `runProductLoopV1` did not. These tests pin both halves: the pause is released
 * on every exit path, and the watchdog actually re-arms afterwards.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loopBehaviour: { mode: "open-card-then-hang" | "open-card-then-throw" } = {
  mode: "open-card-then-hang",
};

vi.mock("../../product-loop/index.js", () => ({
  runProductLoop: vi.fn((opts: { respondToQuestion: (id: string) => Promise<string> }) =>
    (async function* () {
      // Exactly the council's card shape: register the responder (which opens
      // the interactive pause), yield the card chunk, THEN await the human.
      const pending = opts.respondToQuestion("q-abandoned");
      yield { type: "council_question", councilQuestion: { questionId: "q-abandoned", question: "?" } };
      if (loopBehaviour.mode === "open-card-then-throw") throw new Error("loop exploded with a card open");
      await pending; // never resolves — nobody answers
      yield { type: "content", content: "unreachable" };
    })(),
  ),
}));

import { loadCatalog } from "../../models/registry.js";
import { __resetInteractivePauseForTests, isInteractivePaused } from "../interactive-pause.js";
import { Agent } from "../orchestrator.js";
import { TurnStallError, withTurnWatchdog } from "../turn-watchdog.js";

const STATUS_PAYLOAD = {
  subcommand: "status" as const,
  flags: { maxCost: 1, maxSprints: 1, doneThreshold: 0.9 },
};

function makeAgent(): Agent {
  return new Agent("sk-test", undefined, "glm-4.7", undefined, { persistSession: false });
}

describe("runProductLoopV1 — abandoned interactive card must not leak its watchdog pause", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    process.env.MUONROI_TEST_NO_PERSIST = "1";
    process.env.MUONROI_TEST_NO_KEYCHAIN = "1";
    __resetInteractivePauseForTests();
    loopBehaviour.mode = "open-card-then-hang";
  });

  afterEach(() => {
    delete process.env.MUONROI_TEST_NO_PERSIST;
    delete process.env.MUONROI_TEST_NO_KEYCHAIN;
    __resetInteractivePauseForTests();
  });

  it("releases the pause when the consumer abandons the run mid-card (TUI break / Esc)", async () => {
    const gen = makeAgent().runProductLoopV1(STATUS_PAYLOAD);

    const first = await gen.next();
    expect((first.value as { type?: string } | undefined)?.type).toBe("council_question");
    expect(isInteractivePaused()).toBe(true); // human is reading the card

    // The TUI's `for await` breaking out (or the turn watchdog unwinding the
    // generator) surfaces here as `.return()`.
    await gen.return(undefined as never);

    expect(isInteractivePaused()).toBe(false);
  });

  it("releases the pause when the loop throws with a card still open", async () => {
    loopBehaviour.mode = "open-card-then-throw";
    const gen = makeAgent().runProductLoopV1(STATUS_PAYLOAD);

    // First pull yields the card (and opens the pause); the throw lands on the
    // next resumption, i.e. the same place a real provider/tool failure would.
    const first = await gen.next();
    expect((first.value as { type?: string } | undefined)?.type).toBe("council_question");
    expect(isInteractivePaused()).toBe(true);

    await expect(gen.next()).rejects.toThrow(/loop exploded with a card open/);
    expect(isInteractivePaused()).toBe(false);
  });

  it("the turn watchdog re-arms after the abandoned run is released", async () => {
    const gen = makeAgent().runProductLoopV1(STATUS_PAYLOAD);
    await gen.next();
    expect(isInteractivePaused()).toBe(true);

    // A turn whose first chunk takes 400ms — far past the 25ms idle budget.
    const slowTurn = () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 400));
        yield { type: "content", content: "late" };
      })() as AsyncGenerator<{ type: string; content: string }, void, unknown>;

    const watch = (label: string) =>
      withTurnWatchdog(slowTurn() as never, {
        idleMs: 25,
        totalMs: 0,
        label,
        shouldSuppressFire: isInteractivePaused,
      });

    // Control: with the pause held the watchdog re-arms instead of firing, so
    // the slow chunk arrives. That suppression is exactly the damage a leak
    // does — it never expires on its own.
    await expect(watch("control turn").next()).resolves.toMatchObject({
      done: false,
      value: { content: "late" },
    });

    // Abandon the /ideal run — the fix must release the pause…
    await gen.return(undefined as never);
    expect(isInteractivePaused()).toBe(false);

    // …so the identical slow turn is now killed by the re-armed watchdog.
    await expect(watch("later turn").next()).rejects.toBeInstanceOf(TurnStallError);
  });
});
