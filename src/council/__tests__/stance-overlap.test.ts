/**
 * Council defect (a) — two panelists occupying the same position.
 *
 * Run mttwpmu8ee5b seated Researcher / Cost-Controller / Skeptic / Architect.
 * Round-0 positions:
 *
 *   Researcher:      "…sẽ tốn gấp 3–5 lần chi phí phát triển và bảo trì…"
 *   Cost-Controller: "…sẽ tốn gấp 3-4 lần ngân sách dự tính…"
 *
 * and in round 2 the Cost-Controller opened "Đồng ý với lộ trình đề xuất" — it
 * agreed instead of pressuring. Four seats, three positions.
 *
 * Nothing in the code could have caught that: `sanitizeStances`
 * (debate-planner.ts) accepts whatever the planner emits, and the only overlap
 * guidance was a soft prompt clause ("Avoid overlap"). These tests pin a
 * deterministic detector AND the differentiation applied at assignment — the
 * seat is kept, its lens is narrowed.
 */
import { describe, expect, it } from "vitest";
import { detectStanceOverlap, differentiateOverlappingStances, stanceDomains } from "../stance-overlap.js";
import type { DebateStance } from "../types.js";

const researcher: DebateStance = {
  name: "Researcher",
  lens: "What does the evidence and prior art say about the development and maintenance cost of this change?",
};
const costController: DebateStance = {
  name: "Cost-Controller",
  lens: "What does this cost to build, and is the budget justified?",
};
const skeptic: DebateStance = {
  name: "Skeptic",
  lens: "Where does this break — what regression or failure mode is nobody naming?",
};
const architect: DebateStance = {
  name: "Architect",
  lens: "What are the module boundaries and coupling consequences of this design?",
};

describe("stanceDomains", () => {
  it("reads the lens domains a seat claims", () => {
    expect([...stanceDomains(costController)]).toEqual(["cost"]);
    expect([...stanceDomains(skeptic)].sort()).toEqual(["risk"]);
    expect([...stanceDomains(architect)].sort()).toEqual(["architecture"]);
  });

  it("a seat may claim more than one domain", () => {
    // "development and maintenance cost" claims three: cost, evidence, operations.
    expect([...stanceDomains(researcher)].sort()).toEqual(["cost", "evidence", "operations"]);
  });
});

describe("detectStanceOverlap", () => {
  it("flags the seat whose whole lens is already covered by another seat", () => {
    const overlaps = detectStanceOverlap([researcher, costController, skeptic, architect]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ subsumedIndex: 1, coveredByIndex: 0, shared: ["cost"] });
  });

  it("finds nothing in a panel of genuinely distinct lenses", () => {
    expect(detectStanceOverlap([costController, skeptic, architect])).toEqual([]);
  });

  it("catches near-verbatim duplicates even when no domain keyword appears", () => {
    const a: DebateStance = { name: "Voice A", lens: "Weigh the proposal against what the team already shipped." };
    const b: DebateStance = { name: "Voice B", lens: "Weigh the proposal against what the team already shipped." };
    expect(detectStanceOverlap([a, b])).toHaveLength(1);
  });
});

describe("differentiateOverlappingStances", () => {
  it("keeps every seat and narrows the subsumed one instead of dropping it", () => {
    const panel = [researcher, costController, skeptic, architect];
    const { stances, overlaps } = differentiateOverlappingStances(panel);
    expect(stances).toHaveLength(4);
    expect(overlaps).toHaveLength(1);
    expect(stances.map((s) => s.name)).toEqual(panel.map((s) => s.name));
    // The subsumed seat is told, by name, whose ground it must not re-argue.
    expect(stances[1].lens).toContain(researcher.name);
    expect(stances[1].lens).toContain(costController.lens);
    // The covering seat is untouched.
    expect(stances[0]).toEqual(researcher);
  });

  it("is a no-op on a distinct panel (same objects back)", () => {
    const panel = [costController, skeptic, architect];
    const { stances, overlaps } = differentiateOverlappingStances(panel);
    expect(overlaps).toEqual([]);
    expect(stances).toEqual(panel);
  });

  it("leaves a differentiated panel alone on a second pass (idempotent)", () => {
    const once = differentiateOverlappingStances([researcher, costController]).stances;
    const twice = differentiateOverlappingStances(once);
    expect(twice.overlaps).toEqual([]);
    expect(twice.stances).toEqual(once);
  });
});
