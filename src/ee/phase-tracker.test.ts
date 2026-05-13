import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _peekState,
  classifyOutcome,
  endPhase,
  markAborted,
  type PhaseSnapshot,
  recordIntercept,
  recordPostTool,
  resetPhaseTracker,
  setPhase,
} from "./phase-tracker.js";

const refA = { collection: "code", pointId: "a" };
const refB = { collection: "code", pointId: "b" };

beforeEach(() => resetPhaseTracker());
afterEach(() => resetPhaseTracker());

describe("setPhase boundary semantics", () => {
  it("returns null when starting from no active phase", () => {
    expect(setPhase("implement")).toBeNull();
    expect(_peekState()?.phaseName).toBe("implement");
  });

  it("returns null when called with the same phase", () => {
    setPhase("implement");
    expect(setPhase("implement")).toBeNull();
  });

  it("returns a snapshot when the phase name changes", () => {
    setPhase("implement");
    recordIntercept([refA]);
    recordPostTool({ success: true, verifyResult: "pass" });
    const snap = setPhase("verify");
    expect(snap).not.toBeNull();
    expect(snap!.phaseName).toBe("implement");
    expect(snap!.principleRefs).toEqual([refA]);
    expect(snap!.verifyResult).toBe("pass");
    expect(_peekState()?.phaseName).toBe("verify");
  });

  it("setPhase(null) ends the phase and returns a snapshot", () => {
    setPhase("implement");
    recordIntercept([refA]);
    const snap = setPhase(null);
    expect(snap?.phaseName).toBe("implement");
    expect(_peekState()).toBeNull();
  });
});

describe("recordIntercept", () => {
  it("dedupes principle IDs across multiple intercepts in the same phase", () => {
    setPhase("implement");
    recordIntercept([refA]);
    recordIntercept([refA, refB]);
    const snap = endPhase();
    expect(snap!.principleRefs.map((r) => r.pointId).sort()).toEqual(["a", "b"]);
    expect(snap!.toolCount).toBe(2); // tool count increments per call
  });

  it("is a no-op when no phase is active", () => {
    recordIntercept([refA]);
    expect(_peekState()).toBeNull();
  });

  it("filters out malformed refs", () => {
    setPhase("implement");
    recordIntercept([
      refA,
      { collection: "", pointId: "no-coll" } as { collection: string; pointId: string },
      // @ts-expect-error null entry
      null,
    ]);
    const snap = endPhase();
    expect(snap!.principleRefs).toEqual([refA]);
  });
});

describe("recordPostTool", () => {
  it("flags hadFailure on success=false", () => {
    setPhase("implement");
    recordPostTool({ success: false });
    const snap = endPhase();
    expect(snap!.hadFailure).toBe(true);
    expect(snap!.verifyResult).toBeNull();
  });

  it("captures verifyResult", () => {
    setPhase("verify");
    recordPostTool({ success: true, verifyResult: "fail" });
    const snap = endPhase();
    expect(snap!.verifyResult).toBe("fail");
  });
});

describe("markAborted", () => {
  it("sets aborted flag with reason", () => {
    setPhase("implement");
    markAborted("user-pressed-esc");
    const snap = endPhase();
    expect(snap!.aborted).toBe(true);
    expect(snap!.abortReason).toBe("user-pressed-esc");
  });

  it("is a no-op when no phase active", () => {
    markAborted("x");
    expect(_peekState()).toBeNull();
  });
});

describe("classifyOutcome", () => {
  function snap(over: Partial<PhaseSnapshot>): PhaseSnapshot {
    return {
      phaseName: "implement",
      startedAt: 0,
      endedAt: 1,
      toolCount: 0,
      principleRefs: [],
      verifyResult: null,
      hadFailure: false,
      aborted: false,
      ...over,
    };
  }

  it("aborted → abandoned", () => {
    expect(classifyOutcome(snap({ aborted: true, verifyResult: "pass" }))).toBe("abandoned");
  });

  it("verifyResult=fail → fail", () => {
    expect(classifyOutcome(snap({ verifyResult: "fail" }))).toBe("fail");
  });

  it("verifyResult=pass → pass", () => {
    expect(classifyOutcome(snap({ verifyResult: "pass" }))).toBe("pass");
  });

  it("hadFailure alone returns null (insufficient signal)", () => {
    expect(classifyOutcome(snap({ hadFailure: true }))).toBeNull();
  });

  it("nothing observed returns null", () => {
    expect(classifyOutcome(snap({}))).toBeNull();
  });
});

describe("end-to-end phase lifecycle", () => {
  it("captures verify-pass workflow", () => {
    // Turn 1: implement
    setPhase("implement");
    recordIntercept([refA, refB]);
    recordPostTool({ success: true });

    // Turn 2: verify (boundary)
    const drained = setPhase("verify");
    expect(drained!.phaseName).toBe("implement");
    expect(classifyOutcome(drained!)).toBeNull(); // no verify outcome yet

    recordPostTool({ success: true, verifyResult: "pass" });

    // Turn 3: review (boundary again)
    const drained2 = setPhase("review");
    expect(drained2!.phaseName).toBe("verify");
    expect(classifyOutcome(drained2!)).toBe("pass");
  });

  it("captures abort mid-phase as abandoned", () => {
    setPhase("execute");
    recordIntercept([refA]);
    markAborted("user-pressed-esc");
    const drained = endPhase();
    expect(classifyOutcome(drained!)).toBe("abandoned");
  });
});
