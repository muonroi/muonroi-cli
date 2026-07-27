import { describe, expect, it } from "vitest";
import {
  buildLaunchCard,
  cheapRunShape,
  type LaunchPanelist,
  summariseEstimate,
  summariseProviders,
  summariseRoundBudget,
} from "../launch-card.js";

const PANEL: LaunchPanelist[] = [
  { role: "architect", model: "deepseek-v4-pro", stanceName: "architect" },
  { role: "skeptic", model: "glm-4.6", stanceName: "skeptic" },
  { role: "research", model: "deepseek-v4-flash", stanceName: "research" },
];
const providerOf = (m: string) => (m.startsWith("deepseek") ? "deepseek" : "zai");

describe("summariseProviders", () => {
  it("counts and labels a multi-provider lineup", () => {
    expect(summariseProviders(PANEL, providerOf)).toBe("deepseek ×2 · zai (multi-provider lineup)");
  });

  it("drops the multi-provider note when everyone is on one vendor", () => {
    expect(summariseProviders(PANEL, () => "deepseek")).toBe("deepseek ×3");
  });

  // A fabricated vendor name on the launch card is worse than a shorter line.
  it("is empty when no provider can be resolved", () => {
    expect(summariseProviders(PANEL, () => undefined)).toBe("");
    expect(summariseProviders(PANEL)).toBe("");
  });
});

describe("summariseRoundBudget", () => {
  it("names the ceiling when the debate may extend past the plan", () => {
    expect(summariseRoundBudget(3, 5)).toBe("3 max (up to 5 · leader may stop early on convergence)");
  });

  it("omits the ceiling when it adds nothing", () => {
    expect(summariseRoundBudget(3, 3)).toBe("3 max (leader may stop early on convergence)");
    expect(summariseRoundBudget(3)).toBe("3 max (leader may stop early on convergence)");
  });
});

describe("summariseEstimate", () => {
  it("projects a range and says where the number came from", () => {
    const out = summariseEstimate(0.05, 3);
    expect(out).toContain("$0.09–$0.24");
    expect(out).toContain("past council rounds");
  });

  // The whole point: with no history there is nothing to project from, and a
  // wrong figure is the number the user decides against.
  it("is empty without history", () => {
    expect(summariseEstimate(null, 3)).toBe("");
    expect(summariseEstimate(undefined, 3)).toBe("");
    expect(summariseEstimate(0, 3)).toBe("");
  });
});

describe("cheapRunShape", () => {
  it("caps rounds and panelists", () => {
    expect(cheapRunShape({ plannedRounds: 5, panelSize: 6 })).toEqual({ rounds: 2, panelists: 3 });
  });

  // A cheap run must never be MORE expensive than the plan it replaces.
  it("never grows an already-small run", () => {
    expect(cheapRunShape({ plannedRounds: 1, panelSize: 2 })).toEqual({ rounds: 1, panelists: 2 });
  });
});

describe("buildLaunchCard", () => {
  const base = {
    topic: "REST vs gRPC for our microservices",
    leaderModelId: "deepseek-v4-pro",
    participants: PANEL,
    plannedRounds: 3,
    roundCeiling: 5,
    researchOn: true,
    costAware: false,
    providerOf,
  };

  it("leads with the topic and reports the run's shape", () => {
    const card = buildLaunchCard(base);
    expect(card.question).toBe("REST vs gRPC for our microservices");
    expect(card.context).toContain("deepseek-v4-pro will lead · 3 panelists");
    expect(card.context).toContain("Panel: architect · skeptic · research");
    expect(card.context).toContain("Round budget: 3 max (up to 5");
    expect(card.context).toContain("Research: on");
  });

  it("omits the cost line when there is no history to project from", () => {
    expect(buildLaunchCard(base).context).not.toContain("Est. cost");
    expect(buildLaunchCard({ ...base, usdPerRound: 0.05 }).context).toContain("Est. cost");
  });

  it("offers start / cheap / refine / cancel with start recommended", () => {
    const card = buildLaunchCard(base);
    expect(card.options.map((o) => o.value)).toEqual(["start", "cheap", "refine", "cancel"]);
    expect(card.defaultIndex).toBe(0);
    expect(card.options[1]?.description).toContain("2 rounds · 3 panelists");
  });

  it("still renders with an empty panel rather than an empty line", () => {
    const card = buildLaunchCard({ ...base, participants: [] });
    expect(card.context).toContain("Panel: (none resolved)");
  });
});
