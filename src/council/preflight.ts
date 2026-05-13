import type { StreamChunk } from "../types/index.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import type { ClarifiedSpec, PreflightResponder } from "./types.js";

export interface RunPreflightOptions {
  repoEmpty?: boolean;
  researchOverridable?: boolean;
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

  const summary =
    `### Discussion Brief\n\n` +
    `#### Problem\n${spec.problemStatement}\n\n` +
    `#### Constraints\n${spec.constraints.map((c) => `- ${c}`).join("\n") || "- None specified"}\n\n` +
    `#### Success Criteria\n${spec.successCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
    `#### Scope\n${spec.scope || "Not specified"}\n\n` +
    `#### Participants\n${participants.map((p) => `- ${p.role} → ${p.model}`).join("\n")}\n\n` +
    `#### Research phase\n${researchMode}${options?.researchOverridable ? " _(you can skip it after approving)_" : ""}\n`;

  yield { type: "content", content: summary };

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
