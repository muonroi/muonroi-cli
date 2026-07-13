import type { StreamChunk } from "../types/index.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import type { ClarifiedSpec, PreflightResponder } from "./types.js";

/**
 * Emit a harness LiveEvent for a preflight/plan-confirm approval gate.
 *
 * These gates are surfaced as `council_preflight` StreamChunks (a UI render path),
 * NOT as LiveEvents — so a monitor on MUONROI_HARNESS_EVENT_LOG is structurally
 * blind to them, unlike the clarify gate which flows through askcard-open. Emitting
 * askcard-open/answered here lets a wake-at-milestone monitor react to the
 * human-approval pause. Observe-only: never throws, no-op when no agent runtime.
 */
export function emitPreflightHarnessEvent(event: Record<string, unknown>): void {
  try {
    const ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    if (!ar || typeof ar.emitEvent !== "function") return;
    ar.emitEvent(event);
  } catch {
    /* observe-only */
  }
}

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

  emitPreflightHarnessEvent({
    t: "event",
    kind: "askcard-open",
    questionId: preflightId,
    question: `Approve discussion plan for: ${spec.problemStatement}`,
    phase: "preflight",
    optionCount: 2,
    defaultIndex: 0,
  });

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

  emitPreflightHarnessEvent({
    t: "event",
    kind: "askcard-answered",
    questionId: preflightId,
    answerKind: "choice",
    answerText: approved ? "approve" : "reject",
  });

  yield phaseDone({
    phaseId: "phase:preflight",
    kind: "preflight",
    label: "Pre-flight review",
    startedAt,
    detail: approved ? "approved" : "rejected — returning to clarification",
  });

  return approved;
}
