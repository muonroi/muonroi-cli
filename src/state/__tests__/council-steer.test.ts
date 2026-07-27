import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCouncilSteer,
  drainCouncilSteer,
  formatSteerBlock,
  getActiveCouncilRun,
  peekCouncilSteer,
  pushCouncilSteer,
  requestCouncilConverge,
  setActiveCouncilRun,
  shouldCouncilConverge,
} from "../council-steer.js";

const RUN = "run-1";

beforeEach(() => {
  clearCouncilSteer(RUN);
  clearCouncilSteer("run-2");
  setActiveCouncilRun(undefined);
});

describe("pushCouncilSteer", () => {
  it("queues an instruction for the run", () => {
    expect(pushCouncilSteer(RUN, "focus on the descriptor question")).toBe(true);
    expect(peekCouncilSteer(RUN).pending).toBe(1);
  });

  it("ignores empty input and an unknown run", () => {
    expect(pushCouncilSteer(RUN, "   ")).toBe(false);
    expect(pushCouncilSteer(undefined, "x")).toBe(false);
  });

  // Silently dropping the whole paste would leave the user believing the
  // council was steered when it was not.
  it("truncates rather than rejects an over-long instruction", () => {
    pushCouncilSteer(RUN, "x".repeat(2000));
    const [only] = drainCouncilSteer(RUN);
    expect(only?.length).toBe(600);
    expect(only?.endsWith("…")).toBe(true);
  });

  it("caps the queue so a runaway pusher cannot grow it forever", () => {
    for (let i = 0; i < 8; i++) expect(pushCouncilSteer(RUN, `i${i}`)).toBe(true);
    expect(pushCouncilSteer(RUN, "overflow")).toBe(false);
    expect(peekCouncilSteer(RUN).pending).toBe(8);
  });
});

describe("drainCouncilSteer", () => {
  // One nudge shapes ONE round; re-applying it every round would let a single
  // instruction dominate the rest of the debate.
  it("clears what it returns", () => {
    pushCouncilSteer(RUN, "a");
    pushCouncilSteer(RUN, "b");
    expect(drainCouncilSteer(RUN)).toEqual(["a", "b"]);
    expect(drainCouncilSteer(RUN)).toEqual([]);
  });

  it("keeps runs isolated", () => {
    pushCouncilSteer(RUN, "a");
    pushCouncilSteer("run-2", "b");
    expect(drainCouncilSteer("run-2")).toEqual(["b"]);
    expect(drainCouncilSteer(RUN)).toEqual(["a"]);
  });

  // Converge is a run-level decision read at the loop's own exit check; a
  // directive drain must not consume it.
  it("does not clear a pending converge request", () => {
    requestCouncilConverge(RUN);
    pushCouncilSteer(RUN, "a");
    drainCouncilSteer(RUN);
    expect(shouldCouncilConverge(RUN)).toBe(true);
  });
});

describe("clearCouncilSteer", () => {
  // A leftover "force convergence" would silently end the NEXT debate at round 1.
  it("drops the run's state and deregisters it as active", () => {
    setActiveCouncilRun(RUN);
    requestCouncilConverge(RUN);
    pushCouncilSteer(RUN, "a");
    clearCouncilSteer(RUN);
    expect(shouldCouncilConverge(RUN)).toBe(false);
    expect(drainCouncilSteer(RUN)).toEqual([]);
    expect(getActiveCouncilRun()).toBeUndefined();
  });

  it("leaves a different active run registered", () => {
    setActiveCouncilRun("run-2");
    clearCouncilSteer(RUN);
    expect(getActiveCouncilRun()).toBe("run-2");
  });
});

describe("formatSteerBlock", () => {
  it("labels the block as coming from the human", () => {
    const out = formatSteerBlock(["answer the cost claim with a number"]);
    expect(out).toContain("USER STEERING");
    expect(out).toContain("- answer the cost claim with a number");
  });

  // The caller concatenates unconditionally, so nothing queued must produce
  // nothing at all — not a header with an empty list.
  it("is empty for no instructions", () => {
    expect(formatSteerBlock([])).toBe("");
  });
});
