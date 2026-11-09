/**
 * Harness events for the tool-approval card (Semantic id "payment-approval").
 *
 * The card blocks a turn until a human answers (main agent's own must-confirm
 * tool in safe mode, or a worker's approval request). Question cards announce
 * themselves with `askcard-open`; this card did not, so an external driver saw a
 * quiet run and could not tell "waiting on a human" from "hung" (measured: bench
 * session 3d5f51b7b8a0 sat the full 120-min wall on its first read_file approval).
 *
 * Pure builders live here so the identity/payload rules are unit-testable
 * without mounting the 9k-line `use-app-logic.tsx`.
 */

import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import type { ToolApprovalAskInfo } from "../orchestrator/tool-approval.js";
import type { WorkerApprovalView } from "../orchestrator/worker-approval.js";

/** The slice of the pending approval card these builders read. */
export interface ApprovalCardLike {
  toolApproval?: ToolApprovalAskInfo;
  workerApproval?: WorkerApprovalView;
}

export type ApprovalAskcardOpen = Extract<LiveEvent, { kind: "askcard-open" }>;

/** Option labels on the card, in order: index 0 is the default (Allow once). */
const APPROVAL_OPTION_COUNT = 2;

/**
 * Stable id for the card currently shown, or null when it is neither a tool nor
 * a worker approval. Keyed on the call/request identity, so toggling the
 * Allow/Deny selection (which replaces the card object) keeps the same id.
 */
export function approvalQuestionId(card: ApprovalCardLike | null | undefined): string | null {
  if (card?.toolApproval) return `tool-approval-${card.toolApproval.toolCallId}`;
  if (card?.workerApproval) return `worker-approval-${card.workerApproval.id}`;
  return null;
}

/** `askcard-open` payload for an approval card; null when the card is not one. */
export function approvalOpenEvent(card: ApprovalCardLike | null | undefined): ApprovalAskcardOpen | null {
  const questionId = approvalQuestionId(card);
  if (!card || !questionId) return null;
  if (card.toolApproval) {
    const { toolName, preview, toolCallId } = card.toolApproval;
    return {
      t: "event",
      kind: "askcard-open",
      questionId,
      question: `Tool approval: ${toolName}`,
      phase: "tool-approval",
      optionCount: APPROVAL_OPTION_COUNT,
      defaultIndex: 0,
      source: "tool-approval",
      toolName,
      toolCallId,
      preview,
    };
  }
  const request = card.workerApproval!;
  return {
    t: "event",
    kind: "askcard-open",
    questionId,
    question: `Worker approval: ${request.toolName} (job ${request.jobId})`,
    phase: "worker-approval",
    optionCount: APPROVAL_OPTION_COUNT,
    defaultIndex: 0,
    source: "worker-approval",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    preview: request.preview,
    jobId: request.jobId,
  };
}
