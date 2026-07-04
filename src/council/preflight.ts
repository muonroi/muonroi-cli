import type { StreamChunk } from "../types/index.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import type { ClarifiedSpec, PreflightResponder } from "./types.js";

export interface RunPreflightOptions {
  repoEmpty?: boolean;
  researchOverridable?: boolean;
  /**
   * ROI: when the clarifier judged the spec ready (high confidence, no gaps),
   * the approve card is a rubber-stamp. Show the Discussion Brief for
   * transparency but auto-approve without blocking on a gate. Default false —
   * an unready/low-confidence spec still surfaces the approve card.
   */
  autoApprove?: boolean;
}

export async function* runPreflight(
  spec: ClarifiedSpec,
  participants: Array<{ role: string; model: string }>,
  researchNeeded: boolean,
  respondToPreflight: PreflightResponder,
  options?: RunPreflightOptions,
): AsyncGenerator<StreamChunk, boolean, unknown> {
  const preflightId = crypto.randomUUID();
  const startedAt = Date.now();

  yield phaseStart({
    phaseId: "phase:preflight",
    kind: "preflight",
    label: "Pre-flight review",
    detail: `${participants.length} participant${participants.length === 1 ? "" : "s"}`,
  });

  const repoEmpty = options?.repoEmpty === true;
  const researchMode = researchNeeded
    ? repoEmpty
      ? "Yes — internet-first (empty workspace)"
      : "Yes — codebase-first"
    : "No — proceeding directly to debate";

  const researchNote = options?.researchOverridable ? " (you can skip it after approving)" : "";
  yield {
    type: "council_info_card",
    councilInfoCard: {
      title: "Discussion Brief",
      sections: [
        { heading: "Problem", body: spec.problemStatement },
        {
          heading: "Constraints",
          body: spec.constraints.map((c) => `- ${c}`).join("\n") || "- None specified",
        },
        {
          heading: "Success Criteria",
          body: spec.successCriteria.map((c) => `- ${c}`).join("\n"),
        },
        { heading: "Scope", body: spec.scope || "Not specified" },
        {
          heading: "Panel",
          body: participants.map((p) => `- ${p.model}`).join("\n"),
        },
        { heading: "Research phase", body: `${researchMode}${researchNote}` },
      ],
    },
  };

  // ROI: skip the approve gate when the spec is already judged ready — show the
  // brief above for transparency but don't block on a rubber-stamp.
  if (options?.autoApprove === true) {
    yield phaseDone({
      phaseId: "phase:preflight",
      kind: "preflight",
      label: "Pre-flight review",
      startedAt,
      detail: "auto-approved (spec ready)",
    });
    return true;
  }

  yield {
    type: "council_preflight" as StreamChunk["type"],
    content: "Review the discussion brief above. Approve to start debate, or reject to revise.",
    councilPreflight: {
      preflightId,
      problemStatement: spec.problemStatement,
      constraints: spec.constraints,
      successCriteria: spec.successCriteria,
      scope: spec.scope,
      participants,
      researchNeeded,
      repoEmpty,
      researchOverridable: options?.researchOverridable === true,
    },
  };

  const approved = await respondToPreflight(preflightId);

  yield phaseDone({
    phaseId: "phase:preflight",
    kind: "preflight",
    label: "Pre-flight review",
    startedAt,
    detail: approved ? "approved" : "rejected — returning to clarification",
  });

  return approved;
}
