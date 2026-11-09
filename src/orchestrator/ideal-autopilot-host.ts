/**
 * Applies {@link decideAutopilotStep} to a live `/ideal` run: gathers the
 * host-observable facts, persists the autopilot state with the run record
 * (`__ideal_run`, storage/transcript.ts) and announces every transition as a
 * LiveEvent. All collaborators are injected so the stop conditions, persistence
 * and user-precedence rules are testable without a model or a TUI.
 *
 * "The user always wins": `yieldTo` is synchronous, and every evaluation re-reads
 * the record before it persists, so a user action that lands while the host is
 * still measuring (git status, ledger, spend) cancels the pending continuation
 * instead of being overwritten by it.
 */

import {
  type AutopilotConfig,
  type AutopilotDecision,
  type AutopilotObservation,
  type AutopilotSignals,
  type AutopilotStopReason,
  armAutopilot,
  decideAutopilotStep,
  formatAutopilotLine,
  type PersistedAutopilot,
  runFinishedOutcome,
  stopAutopilot,
} from "./ideal-autopilot.js";
import type { IdealCoordinationRun, IdealJob } from "./ideal-coordination.js";

export interface RootCompletion {
  /** `root_status=complete` on the ledger AND, when a native plan exists, a recorded verification pass. */
  complete: boolean;
  /** `implementationVerification` of the native plan; null when the session has no native plan. */
  verification: string | null;
  openItems: number;
}

export interface IdealAutopilotDeps {
  cwd(): string;
  sessionId(): string | undefined;
  /** The open run record; throws when the session store cannot be read. */
  readRun(): IdealCoordinationRun | null;
  writeRun(run: IdealCoordinationRun | null): boolean;
  jobs(run: IdealCoordinationRun): Promise<IdealJob[]>;
  rootCompletion(): Promise<RootCompletion>;
  collectSignals(cwd: string, jobs: readonly IdealJob[]): Promise<AutopilotSignals>;
  spentSince(sessionId: string | undefined, sinceIso: string): Promise<number | null>;
  config(): AutopilotConfig;
  /** Whether a finished worker wakes the model without a human message. */
  autoWake(): boolean;
  emit(event: Record<string, unknown>): void;
  now(): Date;
  log: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

/** What happened to the turn that just ended, as the UI knows it. */
export interface TurnEnd {
  interrupted?: boolean;
  error?: string | null;
  awaitingHuman?: boolean;
}

export class IdealAutopilotHost {
  constructor(private readonly deps: IdealAutopilotDeps) {}

  private eventBase(state: PersistedAutopilot, limits: { maxTurns: number }) {
    return {
      t: "event",
      kind: "ideal-autopilot",
      turn: state.turns,
      // 0 = unlimited (JSON has no infinity).
      maxTurns: Number.isFinite(limits.maxTurns) ? limits.maxTurns : 0,
      noProgressStreak: state.noProgressStreak,
      spentUsd: state.spentUsd,
      ts: this.deps.now().getTime(),
    };
  }

  private announceStop(run: IdealCoordinationRun, state: PersistedAutopilot, limitsMaxTurns: number): void {
    const stop = state.stop;
    if (!stop) return;
    this.deps.emit({ ...this.eventBase(state, { maxTurns: limitsMaxTurns }), action: "stop", reason: stop.reason });
    // The terminal event of the run, same kind a product-loop run ends with. `reason`
    // is the stable stop code; the human sentence is in the transcript and /ideal status.
    this.deps.emit({
      t: "event",
      kind: "run-finished",
      runId: this.deps.sessionId() ?? "",
      subcommand: "start",
      outcome: runFinishedOutcome(stop.reason),
      success: stop.reason === "complete",
      reason: stop.reason,
      sprintsRun: 0,
      shipped: false,
      ts: this.deps.now().getTime(),
    });
    this.deps.log.info("/ideal autopilot stopped", {
      goal: run.goal,
      reason: stop.reason,
      detail: stop.detail,
      turns: state.turns,
      totalTurns: state.totalTurns,
    });
  }

  /**
   * Arm (or re-arm) the autopilot for `run` and persist it with the record. With
   * the autopilot disabled the run is returned (and saved) without any state.
   */
  async arm(run: IdealCoordinationRun, previous?: PersistedAutopilot): Promise<IdealCoordinationRun> {
    const config = this.deps.config();
    if (config.ignored.length > 0)
      this.deps.log.warn("/ideal autopilot: ignoring unusable settings", { ignored: config.ignored });
    const { autopilot: _drop, ...bare } = run;
    if (!config.enabled) {
      this.deps.writeRun(bare);
      return bare;
    }
    let jobs: IdealJob[] = [];
    try {
      jobs = await this.deps.jobs(bare);
    } catch (err) {
      this.deps.log.warn("/ideal autopilot: delegation ledger unreadable while arming", { error: String(err) });
    }
    const signals = await this.deps.collectSignals(this.deps.cwd(), jobs);
    const armed: IdealCoordinationRun = {
      ...bare,
      autopilot: armAutopilot({ now: this.deps.now(), signals, previous }),
    };
    if (!this.deps.writeRun(armed))
      this.deps.log.warn("/ideal autopilot: state could not be saved; it will not survive a restart");
    this.deps.emit({ ...this.eventBase(armed.autopilot!, config.limits), action: "start" });
    return armed;
  }

  /** True while the host would start another turn by itself. Cheap; safe to call from a key handler. */
  isRunning(): boolean {
    try {
      return this.deps.readRun()?.autopilot?.status === "running";
    } catch (err) {
      this.deps.log.warn("/ideal autopilot: run record unreadable", { error: String(err) });
      return false;
    }
  }

  /**
   * The user acted (typed, pressed Esc, `/ideal abort`): stop the autopilot now.
   * Synchronous, idempotent, and a no-op when no autopilot is running.
   */
  yieldTo(reason: Extract<AutopilotStopReason, "user_message" | "user_interrupt" | "user_abort">): void {
    let run: IdealCoordinationRun | null;
    try {
      run = this.deps.readRun();
    } catch (err) {
      this.deps.log.warn("/ideal autopilot: cannot read the run record to yield", { reason, error: String(err) });
      return;
    }
    if (!run?.autopilot || run.autopilot.status !== "running") return;
    const state = stopAutopilot(run.autopilot, reason, reason, this.deps.now());
    // Persisted at once, also for `/ideal abort` (which closes the record when its workers are stopped):
    // no continuation may start in between.
    this.deps.writeRun({ ...run, autopilot: state });
    this.announceStop(run, state, this.deps.config().limits.maxTurns);
  }

  /** The `Autopilot:` line of `/ideal status`; null when the run was started with the autopilot off. */
  statusLine(run: IdealCoordinationRun, now: Date): string | null {
    if (!run.autopilot) return this.deps.config().enabled ? null : "Autopilot: off (MUONROI_IDEAL_AUTOPILOT=0)";
    return formatAutopilotLine(run, this.deps.config().limits, now);
  }

  /**
   * A turn of the run ended. Returns what the host does next; the caller starts
   * the turn for `continue`. Persists the new state and announces transitions.
   */
  async afterTurn(turn: TurnEnd): Promise<AutopilotDecision> {
    let run: IdealCoordinationRun | null;
    try {
      run = this.deps.readRun();
    } catch (err) {
      this.deps.log.error("/ideal autopilot: run record unreadable; not continuing", { error: String(err) });
      return { action: "none" };
    }
    if (!run?.autopilot || run.autopilot.status !== "running") return { action: "none" };
    const config = this.deps.config();
    if (!config.enabled) return { action: "none" };
    const before = run.autopilot;

    let jobs: IdealJob[] = [];
    try {
      jobs = await this.deps.jobs(run);
    } catch (err) {
      this.deps.log.error("/ideal autopilot: delegation ledger unreadable", { error: String(err) });
      return this.finish(run, before, "error", "the delegation ledger could not be read", config);
    }
    const [signals, completion, spentUsd] = await Promise.all([
      this.deps.collectSignals(this.deps.cwd(), jobs),
      this.deps.rootCompletion(),
      this.deps.spentSince(this.deps.sessionId(), before.armedAt),
    ]);

    // The user may have acted while the facts were being gathered.
    let current: IdealCoordinationRun | null;
    try {
      current = this.deps.readRun();
    } catch (err) {
      this.deps.log.error("/ideal autopilot: run record unreadable after measuring; not continuing", {
        error: String(err),
      });
      return { action: "none" };
    }
    if (!current?.autopilot || current.autopilot.status !== "running") return { action: "none" };

    const observation: AutopilotObservation = {
      now: this.deps.now(),
      turn: {
        interrupted: turn.interrupted === true,
        error: turn.error === undefined || turn.error === null ? null : turn.error || "the turn ended in an error",
        awaitingHuman: turn.awaitingHuman === true,
      },
      rootComplete: completion.complete,
      facts: { verification: completion.verification, openItems: completion.openItems },
      runningJobs: jobs.filter((j) => j.status === "running").length,
      autoWake: this.deps.autoWake(),
      signals,
      spentUsd,
    };
    const { state, decision } = decideAutopilotStep(current.autopilot, observation, config.limits);
    if (!this.deps.writeRun({ ...current, autopilot: state }))
      this.deps.log.warn("/ideal autopilot: state could not be saved", { action: decision.action });

    if (decision.action === "stop") this.announceStop(current, state, config.limits.maxTurns);
    else if (decision.action === "continue") {
      this.deps.emit({ ...this.eventBase(state, config.limits), action: "continue" });
      this.deps.log.info("/ideal autopilot: continuing", {
        turn: state.turns,
        maxTurns: config.limits.maxTurns,
        noProgressStreak: state.noProgressStreak,
      });
    } else if (decision.action === "wait") {
      this.deps.emit({ ...this.eventBase(state, config.limits), action: "wait" });
    }
    return decision;
  }

  private finish(
    run: IdealCoordinationRun,
    before: PersistedAutopilot,
    reason: AutopilotStopReason,
    detail: string,
    config: AutopilotConfig,
  ): AutopilotDecision {
    const state = stopAutopilot(before, reason, detail, this.deps.now());
    this.deps.writeRun({ ...run, autopilot: state });
    this.announceStop(run, state, config.limits.maxTurns);
    return { action: "stop", reason, detail };
  }
}
