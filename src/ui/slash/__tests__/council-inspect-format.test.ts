import { describe, expect, it } from "vitest";
import { COUNCIL_SIGILS } from "../../components/role-palette.js";
import { inspectSigil, summariseRound } from "../council-inspect.js";

describe("inspectSigil", () => {
  // The point of the sigil is that it is the SAME identity the live TUI used.
  it("matches the shared palette table by slot", () => {
    expect(inspectSigil(0)).toBe(COUNCIL_SIGILS[0]);
    expect(inspectSigil(2)).toBe(COUNCIL_SIGILS[2]);
  });

  it("wraps past the end of the table instead of going undefined", () => {
    expect(inspectSigil(COUNCIL_SIGILS.length)).toBe(COUNCIL_SIGILS[0]);
    expect(inspectSigil(99)).toBeTruthy();
  });
});

describe("summariseRound", () => {
  it("recovers the criteria score and the decision from the eval prose", () => {
    expect(summariseRound("3/4 criteria met — the panel converged on the edge split")).toMatchObject({
      mark: "◐",
      score: "3/4 met",
      decision: "sufficient — stop",
    });
  });

  it("marks a fully-met round done", () => {
    expect(summariseRound("4/4 criteria met — all resolved, continue not needed").mark).toBe("✓");
  });

  it("marks a round that met nothing", () => {
    expect(summariseRound("0/4 criteria met — continue").mark).toBe("○");
  });

  it("reads 'continue' when nothing stronger is present", () => {
    expect(summariseRound("2/4 criteria met — continue to round 3").decision).toBe("continue");
  });

  it("prefers an abort over a plain continue", () => {
    expect(summariseRound("1/4 criteria met — circuit breaker tripped, continue impossible").decision).toBe(
      "ended early",
    );
  });

  // Every part is independently optional — a partial record must not fabricate.
  it("returns an empty score when the text carries no criteria count", () => {
    expect(summariseRound("the leader decided to continue")).toMatchObject({
      mark: "○",
      score: "",
      decision: "continue",
    });
  });

  it("returns neutral output for missing text rather than inventing an outcome", () => {
    expect(summariseRound(undefined)).toEqual({ mark: "○", score: "", decision: "" });
    expect(summariseRound("")).toEqual({ mark: "○", score: "", decision: "" });
  });

  it("tolerates spacing variations around the slash", () => {
    expect(summariseRound("2 / 4 criteria met").score).toBe("2/4 met");
  });
});
