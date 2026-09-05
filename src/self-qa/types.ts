/**
 * Self-QA — shared types for harness-verified self-test loop.
 *
 * Pipeline:
 *   git diff → scenario-planner → Scenario[]
 *   Scenario → orchestrator → ScenarioRun (events + final frame)
 *   ScenarioRun → judge → JudgeResult
 *   passing JudgeResult → spec-emitter → tests/harness/auto/*.spec.ts
 */

import type { LiveEvent, LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";

/** A semantic ID extracted from a `<Semantic id="X" role="Y">` wrapper. */
export type SemanticHit = {
  id: string;
  role: string;
  name?: string;
  isModal?: boolean;
  file: string;
  line: number;
};

export type ScenarioStep =
  | { op: "type"; text: string }
  | { op: "press"; key: string }
  | { op: "press_sequence"; keys: string[] }
  | { op: "focus"; selector: string }
  | {
      op: "wait_for";
      selector?: string;
      event?: string;
      idle?: true;
      timeoutMs?: number;
    };

export type Expectation =
  | { kind: "noErrorToast" }
  | { kind: "eventFired"; event: string; payloadMatch?: Record<string, unknown> }
  | { kind: "eventAbsent"; event: string }
  | { kind: "selectorPresent"; selector: string }
  | { kind: "selectorAbsent"; selector: string }
  | { kind: "idleReached"; withinMs?: number };

export type Scenario = {
  id: string;
  description: string;
  derivedFrom: {
    files: string[];
    semanticIds: string[];
  };
  steps: ScenarioStep[];
  expectations: Expectation[];
  /** Estimated wall-clock budget for the full scenario. */
  budgetMs: number;
  /**
   * False when the planner knows no way to bring this surface on screen (no
   * registered opener, and the surface is not top-level). Such a scenario is
   * still PLANNED — so callers can see the surface was noticed — but it is not
   * RUN, because driving it would block on a `wait_for` that can never resolve
   * and produce a permanent `inconclusive`.
   *
   * "I do not know how to reach this" is reported as `skipped`, which is
   * honest, and is deliberately kept distinct from "I drove it and the harness
   * broke" (`inconclusive`). Defaults to true when omitted.
   */
  reachable?: boolean;
  /** Human-readable reason, set whenever `reachable === false`. */
  unreachableReason?: string;
};

export type ScenarioRun = {
  scenario: Scenario;
  events: LiveEvent[];
  finalFrame: LiveFrame | null;
  startedAt: number;
  endedAt: number;
  /** Set when orchestrator hit hard timeout. */
  timedOut: boolean;
  /** Set when child process exited unexpectedly. */
  crashed: boolean;
  /** Captured stderr or stack from any caught error. */
  errorTrace?: string;
  /**
   * Number of `{t:"idle"}` sentinels observed on the sidechannel during this
   * scenario's window. `idleReached` is judged against this: without it the
   * check was a tautology that a zero-step run satisfied (it only compared
   * wall-clock duration to the budget, so `durationMs: 0` "reached idle").
   */
  idleObserved: number;
  /**
   * Human-readable descriptions of `wait_for` steps that expired. A step is a
   * SYNCHRONISATION primitive, not an assertion: its expiry must not abort the
   * scenario, because doing so skipped the scenario's real `expectations`
   * entirely and silently discarded the only assertions it had.
   */
  syncTimeouts: string[];
};

export type CheckResult = {
  expectation: Expectation;
  passed: boolean;
  reason: string;
};

export type JudgeVerdict = "pass" | "fail" | "inconclusive";

export type JudgeResult = {
  verdict: JudgeVerdict;
  scenarioId: string;
  checks: CheckResult[];
  durationMs: number;
};

/** Frame delta — emitted by delta-encoder. */
export type FrameDelta = {
  seq: number;
  baseSeq: number | null;
  added: UINode[];
  removed: string[];
  changed: {
    id: string;
    fields: Partial<Pick<UINode, "name" | "value" | "state" | "focus" | "selected" | "disabled" | "hidden">>;
  }[];
  focusChanged?: { from?: string; to?: string };
  modalsChanged?: { from: string[]; to: string[] };
};
