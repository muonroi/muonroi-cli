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
      /**
       * Marks this wait as the scenario's READINESS gate: until it resolves the
       * TUI is not driveable, so nothing after it means anything.
       *
       * The judge uses it to separate "the assertion failed" from "the child
       * never became ready" — see `ScenarioRun.mounted`. It is set on the
       * planner's `MOUNT_GUARD` only, never inferred from a selector, so a
       * scenario whose readiness condition IS its assertion (`smoke-boot`
       * waits for idle and then asserts `idleReached`) keeps reporting a real
       * negative instead of being excused as un-driveable.
       */
      guard?: true;
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

  /**
   * Did the scenario's readiness gate (`ScenarioStep.guard`) resolve?
   *
   * `false` means the TUI never became driveable, so every step after the gate
   * was dispatched into a UI that was not there and every UI expectation is
   * UNPROVEN rather than failed. Absent/`true` = as before.
   *
   * This is the misclassification the field exists to close. `judge` ranks "a
   * definite negative outranks could-not-establish", which is right — but a
   * `selectorPresent` miss against a UI that never mounted is not a definite
   * negative, it is the absence of a measurement. Measured on the committed
   * code: with the mount guard expired, `finalFrame` is `null`,
   * `checkSelectorPresent` returns "No final frame captured", `anyFailed`
   * becomes true and the verdict is `fail` → exit 1 → the pre-push hook prints
   * "self-verify FAILED — blocking push". A transient slow boot was therefore
   * reported as a regression in the developer's change, and the obvious next
   * move — push again — "fixed" it. That is how a gate teaches `--no-verify`.
   */
  mounted?: boolean;

  /** The readiness gate's description, so the failure line can name it. */
  mountGuard?: { label: string; timeoutMs: number; waitedMs: number };

  /** Was the child still running when the scenario ended? */
  childAlive?: boolean;

  /** The child's exit status, when it had already exited. */
  childExit?: { code: number | null; signal: string | null };

  /**
   * Tail of the child's stderr.
   *
   * The orchestrator spawns with `stdio: ["pipe","pipe","pipe"]` and used to
   * read NONE of it, so anything the child printed while failing — a stack
   * trace, a provider error, the `[agent-mode] pre-mount command buffer full`
   * warning — was discarded. Measured on a healthy run: 819 bytes per child
   * (mock-model fixture notices + an env-store precedence warning), and 17.5 KB
   * on stdout in a 5 s scenario / ~1.4 KB/s while merely parked at the prompt.
   * Capturing the tail is what makes a failure self-explaining; draining also
   * stops that stream accumulating unread in the OS pipe buffer.
   */
  stderrTail?: string;
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
