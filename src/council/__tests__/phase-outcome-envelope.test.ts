import { describe, expect, it } from "vitest";
import type { EnhancedCouncilOutcome } from "../types.js";
import { buildPhaseOutcomeEnvelope, resolvePhaseOutcomeTransition } from "../types.js";

const outcome: EnhancedCouncilOutcome = {
  type: "evaluation",
  summary: "Council reached a conclusion.",
};

describe("PhaseOutcomeEnvelope", () => {
  it("hard-stops invalidated outcomes when synthesis failed", () => {
    const envelope = buildPhaseOutcomeEnvelope({
      outcome: null,
      synthesisFailReason: "leader returned malformed JSON",
      participantCount: 2,
      activeCount: 2,
    });

    expect(envelope.trustLevel).toBe("invalidated");
    expect(envelope.failureClass).toBe("synthesis_failed");
    expect(resolvePhaseOutcomeTransition(envelope, "implement")).toBe("hard_stop");
    expect(envelope.visibilityMessage).toContain("validated structured outcome");
  });

  it("degrades partial-panel build actions to follow-up work", () => {
    const envelope = buildPhaseOutcomeEnvelope({
      outcome,
      participantCount: 3,
      activeCount: 2,
    });

    expect(envelope.trustLevel).toBe("degraded");
    expect(envelope.failureClass).toBe("partial_panel");
    expect(envelope.degradationKinds).toContain("partial_panel");
    expect(resolvePhaseOutcomeTransition(envelope, "implement")).toBe("degrade");
  });

  it("degrades accepted open criteria", () => {
    const envelope = buildPhaseOutcomeEnvelope({
      outcome,
      participantCount: 2,
      activeCount: 2,
      unmetCriteriaCount: 1,
      acceptedEscalation: true,
    });

    expect(envelope.trustLevel).toBe("degraded");
    expect(envelope.degradationKinds).toContain("accepted_open_criteria");
    expect(resolvePhaseOutcomeTransition(envelope, "continue_session")).toBe("degrade");
  });

  it("degrades ungrounded tagged claims", () => {
    const envelope = buildPhaseOutcomeEnvelope({
      outcome,
      participantCount: 2,
      activeCount: 2,
      taggedClaims: 4,
      evidenceDensity: 0,
    });

    expect(envelope.failureClass).toBe("ungrounded");
    expect(envelope.degradationKinds).toContain("evidence_gap");
    expect(envelope.visibilityMessage).toContain("Decision quality degraded");
  });

  it("allows nominal continuation for high-trust outcomes", () => {
    const envelope = buildPhaseOutcomeEnvelope({
      outcome,
      participantCount: 2,
      activeCount: 2,
      taggedClaims: 0,
      evidenceDensity: 0,
    });

    expect(envelope.trustLevel).toBe("high");
    expect(resolvePhaseOutcomeTransition(envelope, "implement")).toBe("continue");
    expect(resolvePhaseOutcomeTransition(envelope, "save_exit")).toBe("continue");
  });
});
