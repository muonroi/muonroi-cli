import { describe, expect, it } from "vitest";
import type { CouncilPhaseEvent } from "../../../types/index.js";
import { upsertPhase } from "../council-phase-timeline.js";

function makePhase(overrides: Partial<CouncilPhaseEvent> = {}): CouncilPhaseEvent {
  return {
    phaseId: "phase:research",
    kind: "research",
    state: "active",
    label: "Research",
    ...overrides,
  };
}

describe("upsertPhase", () => {
  it("appends a new phase to an empty list", () => {
    const next = upsertPhase([], makePhase());
    expect(next.length).toBe(1);
    expect(next[0].state).toBe("active");
  });

  it("preserves insertion order when adding multiple phases", () => {
    const a = makePhase({ phaseId: "phase:a", label: "A" });
    const b = makePhase({ phaseId: "phase:b", label: "B" });
    const c = makePhase({ phaseId: "phase:c", label: "C" });
    const list = [a, b, c].reduce((acc, p) => upsertPhase(acc, p), [] as CouncilPhaseEvent[]);
    expect(list.map((p) => p.phaseId)).toEqual(["phase:a", "phase:b", "phase:c"]);
  });

  it("transitions an active phase to done in place without reordering", () => {
    const a = makePhase({ phaseId: "phase:a", label: "A" });
    const b = makePhase({ phaseId: "phase:b", label: "B" });
    let list: CouncilPhaseEvent[] = [];
    list = upsertPhase(list, a);
    list = upsertPhase(list, b);
    list = upsertPhase(list, { ...a, state: "done", elapsedMs: 1234 });
    expect(list.map((p) => p.phaseId)).toEqual(["phase:a", "phase:b"]);
    expect(list[0].state).toBe("done");
    expect(list[0].elapsedMs).toBe(1234);
  });

  it("preserves prior detail when the new event omits it", () => {
    let list: CouncilPhaseEvent[] = [];
    list = upsertPhase(list, makePhase({ detail: "via gpt-4" }));
    list = upsertPhase(list, makePhase({ state: "done", elapsedMs: 500 }));
    expect(list[0].detail).toBe("via gpt-4");
    expect(list[0].elapsedMs).toBe(500);
  });

  it("records error state with errorMessage", () => {
    let list: CouncilPhaseEvent[] = [];
    list = upsertPhase(list, makePhase());
    list = upsertPhase(list, makePhase({ state: "error", errorMessage: "API down" }));
    expect(list[0].state).toBe("error");
    expect(list[0].errorMessage).toBe("API down");
  });
});
