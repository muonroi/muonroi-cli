/**
 * src/storage/ui-interaction-log.ts
 *
 * Typed, fail-open helpers for persisting UI lifecycle events (askcard
 * open/answered/cancel, sprint stage transitions, sprint halt, route
 * decisions) into `interaction_logs` with event_type='ui_interaction'.
 *
 * The matching LiveEvent payloads are emitted to the harness sidechannel
 * for E2E tests — these helpers persist the *same* events so that
 * `/export` can render an Interaction Timeline section reconstructing
 * what the user did (which option, which key, at what step).
 *
 * All calls are fire-and-forget — DB errors must never break the UI flow.
 */

import { logInteraction } from "./interaction-log.js";

export type UIInteractionSubtype =
  | "route_decision"
  | "sprint_stage"
  | "sprint_halt"
  | "askcard_open"
  | "askcard_answered"
  | "askcard_cancel"
  | "halt_card_open"
  | "halt_card_answered"
  | "init_new_step"
  | "init_new_submitted"
  | "init_new_result";

interface RouteDecisionPayload {
  path: "hot-path" | "council";
  complexity: string;
  forceCouncil: boolean;
  runId: string;
}

interface SprintStagePayload {
  sprintIndex: number;
  stage: "planning" | "implementation" | "verification" | "judgment";
  runId: string;
}

interface SprintHaltPayload {
  sprintN: number;
  reason: string;
  runId: string;
}

interface AskcardOpenPayload {
  questionId: string;
  question: string;
  phase: string;
  optionCount: number;
  defaultIndex?: number;
}

interface AskcardAnsweredPayload {
  questionId: string;
  answerKind: string;
  answerText: string;
}

interface AskcardCancelPayload {
  questionId: string;
}

interface HaltCardOpenPayload {
  reason: string;
  optionCount: number;
  optionIds: string[];
}

interface HaltCardAnsweredPayload {
  chosenId: string;
  chosenLabel: string;
  index: number;
}

interface InitNewStepPayload {
  from: string;
  to: string;
}

interface InitNewSubmittedPayload {
  projectName: string;
  feStack: string;
  bbTemplate: string | null;
  packageCount: number;
}

interface InitNewResultPayload {
  outcome: "done" | "error";
  message: string;
  usedDotnetTemplate?: boolean;
}

type Payload =
  | { subtype: "route_decision"; data: RouteDecisionPayload }
  | { subtype: "sprint_stage"; data: SprintStagePayload }
  | { subtype: "sprint_halt"; data: SprintHaltPayload }
  | { subtype: "askcard_open"; data: AskcardOpenPayload }
  | { subtype: "askcard_answered"; data: AskcardAnsweredPayload }
  | { subtype: "askcard_cancel"; data: AskcardCancelPayload }
  | { subtype: "halt_card_open"; data: HaltCardOpenPayload }
  | { subtype: "halt_card_answered"; data: HaltCardAnsweredPayload }
  | { subtype: "init_new_step"; data: InitNewStepPayload }
  | { subtype: "init_new_submitted"; data: InitNewSubmittedPayload }
  | { subtype: "init_new_result"; data: InitNewResultPayload };

/**
 * Persist a UI lifecycle event. Caller passes a discriminated payload so
 * downstream consumers (export renderer, future analytics) can rely on a
 * fixed shape per subtype without parsing free-form JSON.
 */
export function logUIInteraction(sessionId: string | undefined | null, payload: Payload): void {
  if (!sessionId) return;
  try {
    logInteraction(sessionId, "ui_interaction", {
      eventSubtype: payload.subtype,
      data: payload.data as unknown as Record<string, unknown>,
    });
  } catch {
    // Fail-open
  }
}
