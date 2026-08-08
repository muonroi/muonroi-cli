import { describe, expect, it } from "vitest";
import {
  buildLaunchCard,
  cheapRunShape,
  EDIT_SPEC_OPTION_VALUE,
  type LaunchPanelist,
  MAX_RENDERED_SUCCESS_CRITERIA,
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

  it("offers start / cheap / edit / refine / cancel with start recommended", () => {
    const card = buildLaunchCard(base);
    expect(card.options.map((o) => o.value)).toEqual(["start", "cheap", EDIT_SPEC_OPTION_VALUE, "refine", "cancel"]);
    expect(card.defaultIndex).toBe(0);
    expect(card.options[1]?.description).toContain("2 rounds · 3 panelists");
  });

  it("still renders with an empty panel rather than an empty line", () => {
    const card = buildLaunchCard({ ...base, participants: [] });
    expect(card.context).toContain("Panel: (none resolved)");
  });

  // Amendment A2 — Topic + Outcome block (task A2).
  describe("Topic + Outcome (Amendment A2)", () => {
    it("falls back to the raw topic as the headline when no problemStatement is given", () => {
      expect(buildLaunchCard(base).question).toBe("REST vs gRPC for our microservices");
    });

    it("uses the problem statement as the headline when present, not the raw topic", () => {
      const card = buildLaunchCard({
        ...base,
        topic: "should we use grpc",
        problemStatement: "Decide whether internal microservices should communicate over gRPC or REST.",
      });
      expect(card.question).toBe("Decide whether internal microservices should communicate over gRPC or REST.");
    });

    it("renders successCriteria as an Outcome row", () => {
      const card = buildLaunchCard({
        ...base,
        successCriteria: ["Latency stays under 50ms p99", "No breaking change to the public API"],
      });
      expect(card.context).toContain("Outcome: - Latency stays under 50ms p99");
      expect(card.context).toContain("- No breaking change to the public API");
    });

    it("omits the Outcome row when there is no success criteria", () => {
      expect(buildLaunchCard(base).context).not.toContain("Outcome:");
      expect(buildLaunchCard({ ...base, successCriteria: [] }).context).not.toContain("Outcome:");
    });

    it("caps rendered criteria at MAX_RENDERED_SUCCESS_CRITERIA and says how many were left out", () => {
      const many = Array.from({ length: MAX_RENDERED_SUCCESS_CRITERIA + 4 }, (_, i) => `Criterion ${i + 1}`);
      const card = buildLaunchCard({ ...base, successCriteria: many });
      for (let i = 0; i < MAX_RENDERED_SUCCESS_CRITERIA; i++) {
        expect(card.context).toContain(`Criterion ${i + 1}`);
      }
      expect(card.context).not.toContain(`Criterion ${MAX_RENDERED_SUCCESS_CRITERIA + 1}`);
      expect(card.context).toContain("…and 4 more");
    });

    it("the edit option is present alongside refine and cancel, not instead of them", () => {
      const values = buildLaunchCard(base).options.map((o) => o.value);
      expect(values).toContain(EDIT_SPEC_OPTION_VALUE);
      expect(values).toContain("refine");
      expect(values).toContain("cancel");
    });

    it("allowEdit:false hides the edit option while leaving everything else intact", () => {
      const values = buildLaunchCard({ ...base, allowEdit: false }).options.map((o) => o.value);
      expect(values).toEqual(["start", "cheap", "refine", "cancel"]);
    });
  });

  // Session 770cc78e13cc: the spec step produced no problemStatement, and the
  // raw-topic fallback rendered a 7.5KB pasted brief as the card headline.
  describe("headline fallback when no problemStatement was distilled", () => {
    it("uses the distilled problemStatement whenever there is one", () => {
      const card = buildLaunchCard({ ...base, problemStatement: "Decide the retry-budget decomposition." });
      expect(card.question).toBe("Decide the retry-budget decomposition.");
    });

    it("clamps a long raw topic to its first line instead of dumping the whole brief", () => {
      const brief = `${"# Council question: how many independent things does this task require".repeat(6)}\nline two\nline three`;
      const card = buildLaunchCard({ ...base, problemStatement: undefined, topic: brief });
      expect(card.question.length).toBeLessThanOrEqual(241); // 240 + the ellipsis
      expect(card.question.endsWith("…")).toBe(true);
      expect(card.question).not.toContain("line two");
    });

    it("leaves a short topic untouched — no gratuitous ellipsis", () => {
      const card = buildLaunchCard({ ...base, problemStatement: undefined, topic: "REST vs gRPC" });
      expect(card.question).toBe("REST vs gRPC");
    });
  });
});
