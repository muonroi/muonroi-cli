import { describe, expect, it } from "vitest";
import { buildStanceRows, resolveRoleKey } from "../stance.js";

const ROSTER = ["architect", "skeptic", "research"];

function status(entries: Array<Record<string, unknown>>) {
  return entries as unknown as Parameters<typeof buildStanceRows>[0]["criteriaStatus"];
}

describe("buildStanceRows", () => {
  it("maps per-role marks onto the pinned criteria in order", () => {
    const rows = buildStanceRows({
      criteria: ["latency", "contract"],
      criteriaStatus: status([
        { criterion: "latency", met: true, evidence: "", stances: { architect: "+", skeptic: "+", research: "+" } },
        {
          criterion: "contract",
          met: false,
          evidence: "",
          stances: { architect: "+", skeptic: "-", research: null },
          split: "is the descriptor part of the contract?",
        },
      ]),
      roster: ROSTER,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.stances).toEqual({ architect: "+", skeptic: "+", research: "+" });
    expect(rows[1]!.stances).toEqual({ architect: "+", skeptic: "-", research: null });
    expect(rows[1]!.split).toBe("is the descriptor part of the contract?");
  });

  // The core safety property: an un-graded criterion must not read as consensus.
  it("emits an all-null row for a criterion the leader did not grade", () => {
    const rows = buildStanceRows({
      criteria: ["latency", "rollout cost"],
      criteriaStatus: status([{ criterion: "latency", met: true, evidence: "", stances: { architect: "+" } }]),
      roster: ROSTER,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.criterion).toBe("rollout cost");
    expect(rows[1]!.stances).toEqual({ architect: null, skeptic: null, research: null });
    expect(rows[1]!.met).toBe(false);
  });

  it("degrades a whole missing stances map to null rather than agreement", () => {
    const rows = buildStanceRows({
      criteria: ["latency"],
      criteriaStatus: status([{ criterion: "latency", met: true, evidence: "ok" }]),
      roster: ROSTER,
    });
    // met is honoured (the leader DID grade it) but nobody is credited a position.
    expect(rows[0]!.met).toBe(true);
    expect(rows[0]!.stances).toEqual({ architect: null, skeptic: null, research: null });
  });

  it("drops a role the leader invented instead of adding a phantom column", () => {
    const rows = buildStanceRows({
      criteria: ["latency"],
      criteriaStatus: status([
        { criterion: "latency", met: false, evidence: "", stances: { architect: "+", auditor: "-" } },
      ]),
      roster: ROSTER,
    });
    expect(Object.keys(rows[0]!.stances).sort()).toEqual([...ROSTER].sort());
    expect(rows[0]!.stances).not.toHaveProperty("auditor");
  });

  it("nulls a mark outside the +/-/~ set", () => {
    const rows = buildStanceRows({
      criteria: ["latency"],
      criteriaStatus: status([
        { criterion: "latency", met: false, evidence: "", stances: { architect: "yes", skeptic: "?", research: "" } },
      ]),
      roster: ROSTER,
    });
    expect(rows[0]!.stances).toEqual({ architect: null, skeptic: null, research: null });
  });

  it("folds unicode minus variants onto ASCII '-'", () => {
    const rows = buildStanceRows({
      criteria: ["latency"],
      criteriaStatus: status([
        { criterion: "latency", met: false, evidence: "", stances: { architect: "−", skeptic: "–", research: "—" } },
      ]),
      roster: ROSTER,
    });
    expect(rows[0]!.stances).toEqual({ architect: "-", skeptic: "-", research: "-" });
  });

  it("recovers a reordered payload by criterion text", () => {
    const rows = buildStanceRows({
      criteria: ["latency", "contract"],
      criteriaStatus: status([
        { criterion: "contract", met: false, evidence: "", stances: { skeptic: "-" } },
        { criterion: "latency", met: true, evidence: "", stances: { architect: "+" } },
      ]),
      roster: ROSTER,
    });
    expect(rows[0]!.criterion).toBe("latency");
    expect(rows[0]!.stances.architect).toBe("+");
    expect(rows[1]!.stances.skeptic).toBe("-");
  });

  it("survives a non-array criteriaStatus without throwing", () => {
    const rows = buildStanceRows({
      criteria: ["latency"],
      criteriaStatus: null as unknown as Parameters<typeof buildStanceRows>[0]["criteriaStatus"],
      roster: ROSTER,
    });
    expect(rows[0]!.stances).toEqual({ architect: null, skeptic: null, research: null });
  });
});

describe("resolveRoleKey", () => {
  it("matches exactly, then case-insensitively", () => {
    expect(resolveRoleKey("architect", ROSTER)).toBe("architect");
    expect(resolveRoleKey("Architect", ROSTER)).toBe("architect");
  });

  it("accepts an unambiguous abbreviation", () => {
    expect(resolveRoleKey("arc", ROSTER)).toBe("architect");
  });

  // Attributing a stance to the wrong panelist is the failure this guards.
  it("refuses an ambiguous prefix rather than guessing", () => {
    expect(resolveRoleKey("s", ["skeptic", "security"])).toBeNull();
  });

  it("rejects an unknown role", () => {
    expect(resolveRoleKey("auditor", ROSTER)).toBeNull();
  });
});
