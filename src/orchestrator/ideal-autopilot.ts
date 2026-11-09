/**
 * Host autopilot for an orchestrator-role `/ideal` run — pure policy.
 *
 * Evidence (session 55c5b65b6938, /ideal on the experience-engine endpoint
 * task): the work finished and 545/545 tests passed, but the run never closed.
 * The orchestrator ended its turn after every step and waited for a human
 * "continue" — four times even after being granted full authority — because
 * nothing in the host started the next turn. The `doneThreshold: 0.9` flag
 * passed to `runProductLoopV1` was read by nobody.
 *
 * The principle (feedback_native_rules_not_context): the HOST enforces the loop;
 * the model is not asked in prose to "keep going". After a turn of an armed
 * `/ideal` run ends, {@link decideAutopilotStep} says whether the host starts
 * the next turn itself or stops, from host-observable facts only. The caller
 * (orchestrator.ts) gathers the facts and applies the decision; this module does
 * no I/O, so every stop condition is unit-testable.
 *
 * Stop conditions, evaluated in this order (first match wins):
 *   1. user_interrupt / user_message / user_abort — the user always wins. These
 *      are applied by the orchestrator the moment the user acts (Esc, a typed
 *      message, `/ideal abort`), not at turn end.
 *   2. error         — the turn ended in a hard error.
 *   3. needs_human   — a card (askcard / preflight / halt / approval) awaits a
 *                      human at turn end. The host never answers it.
 *   4. complete      — the root goal is `root_status=complete` (host-gated: no
 *                      open items and a recorded FLOW `flow_verify` pass).
 *   5. budget_cost / budget_wall — spend or elapsed time of this budget window.
 *   6. no_progress   — `noProgressTurns` consecutive turn ends with none of the
 *                      three progress signals (see {@link AutopilotSignals}).
 *                      Waiting on running workers is not a stall and does not
 *                      count.
 *   7. autowake_off  — workers are running but their results cannot wake the
 *                      model (MUONROI_BACKGROUND_AUTOWAKE=0); nothing would
 *                      ever continue the run.
 *   8. budget_turns  — `maxTurns` host-started turns in this budget window.
 * Otherwise: workers running → `wait` (their result wakes the model, and that
 * turn's end is evaluated again); else → `continue`.
 */
import type {
  AutopilotSignals,
  AutopilotStopReason,
  PersistedAutopilot,
  PersistedIdealRun,
} from "../storage/transcript.js";

export type { AutopilotSignals, AutopilotStopReason, PersistedAutopilot };

export interface AutopilotLimits {
  /** Host-started continuation turns per budget window. */
  maxTurns: number;
  /** Cost cap in USD per budget window; null = no cap (the standing /ideal default). */
  maxCostUsd: number | null;
  /** Wall-clock cap per budget window, in ms. */
  maxWallMs: number;
  /** Consecutive turn ends without progress that stop the run. */
  noProgressTurns: number;
}

export interface AutopilotConfig {
  enabled: boolean;
  limits: AutopilotLimits;
  /** Settings/env values that were present but unusable (logged by the caller, then ignored). */
  ignored: string[];
}

/** Defaults. Documented in docs/architecture/FLOW-PIPELINE.md ("Host autopilot"). */
export const AUTOPILOT_DEFAULTS = {
  maxTurns: 40,
  maxWallMinutes: 240,
  noProgressTurns: 3,
} as const;

/** `settings.json` → `idealAutopilot`. Every field optional; env wins over settings. */
export interface IdealAutopilotSettings {
  enabled?: boolean;
  maxTurns?: number;
  maxCostUsd?: number;
  maxWallMinutes?: number;
  noProgressTurns?: number;
}

const OFF = new Set(["0", "false", "off", "no"]);

/** A limit for display: an unlimited one (0 in settings/env) reads as the infinity sign. */
const lim = (n: number): string => (Number.isFinite(n) ? String(n) : "∞");

/**
 * Env knobs (each overrides the matching `idealAutopilot.*` setting):
 *   MUONROI_IDEAL_AUTOPILOT=0               disable the autopilot (the old "one turn per human message" behaviour)
 *   MUONROI_IDEAL_AUTOPILOT_MAX_TURNS       host-started turns per window           (default 40; 0 = no limit)
 *   MUONROI_IDEAL_AUTOPILOT_MAX_COST_USD    cost cap per window; 0 = no cap         (default: no cap)
 *   MUONROI_IDEAL_AUTOPILOT_MAX_WALL_MIN    wall-clock minutes per window           (default 240; 0 = no limit)
 *   MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS     consecutive no-progress turn ends       (default 3)
 */
export function resolveAutopilotConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings: IdealAutopilotSettings | undefined = undefined,
): AutopilotConfig {
  const ignored: string[] = [];
  const positive = (name: string, raw: unknown, allowZero = false): number | undefined => {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (Number.isFinite(n) && (allowZero ? n >= 0 : n > 0)) return n;
    ignored.push(`${name}=${JSON.stringify(raw)}`);
    return undefined;
  };
  const whole = (n: number | undefined) => (n === undefined ? undefined : Math.max(1, Math.floor(n)));
  const whole0 = (n: number | undefined) => (n === undefined ? undefined : Math.floor(n));
  /** 0 = no limit (the standing /ideal default is "no budget"; the caps here are opt-out, not mandatory). */
  const unlimitedIfZero = (n: number | undefined) => (n === 0 ? Number.POSITIVE_INFINITY : n);

  const envOff = env.MUONROI_IDEAL_AUTOPILOT?.trim().toLowerCase();
  const enabled = envOff !== undefined && envOff !== "" ? !OFF.has(envOff) : (settings?.enabled ?? true);

  const maxTurns =
    unlimitedIfZero(
      whole0(positive("MUONROI_IDEAL_AUTOPILOT_MAX_TURNS", env.MUONROI_IDEAL_AUTOPILOT_MAX_TURNS, true)),
    ) ??
    unlimitedIfZero(whole0(positive("idealAutopilot.maxTurns", settings?.maxTurns, true))) ??
    AUTOPILOT_DEFAULTS.maxTurns;
  const cost =
    positive("MUONROI_IDEAL_AUTOPILOT_MAX_COST_USD", env.MUONROI_IDEAL_AUTOPILOT_MAX_COST_USD, true) ??
    positive("idealAutopilot.maxCostUsd", settings?.maxCostUsd, true);
  const wallMin =
    unlimitedIfZero(positive("MUONROI_IDEAL_AUTOPILOT_MAX_WALL_MIN", env.MUONROI_IDEAL_AUTOPILOT_MAX_WALL_MIN, true)) ??
    unlimitedIfZero(positive("idealAutopilot.maxWallMinutes", settings?.maxWallMinutes, true)) ??
    AUTOPILOT_DEFAULTS.maxWallMinutes;
  const noProgress =
    whole(positive("MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS", env.MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS)) ??
    whole(positive("idealAutopilot.noProgressTurns", settings?.noProgressTurns)) ??
    AUTOPILOT_DEFAULTS.noProgressTurns;

  return {
    enabled,
    limits: {
      maxTurns,
      maxCostUsd: cost === undefined || cost === 0 ? null : cost,
      maxWallMs: Math.round(wallMin * 60_000),
      noProgressTurns: noProgress,
    },
    ignored,
  };
}

/** A fresh budget window (`/ideal start`, or `/ideal resume` — which keeps `totalTurns`). */
export function armAutopilot(input: {
  now: Date;
  signals: AutopilotSignals;
  previous?: PersistedAutopilot;
}): PersistedAutopilot {
  return {
    status: "running",
    armedAt: input.now.toISOString(),
    turns: 0,
    totalTurns: input.previous?.totalTurns ?? 0,
    noProgressStreak: 0,
    signals: input.signals,
    spentUsd: 0,
  };
}

/** Close the autopilot. A state that is already stopped keeps its first reason. */
export function stopAutopilot(
  state: PersistedAutopilot,
  reason: AutopilotStopReason,
  detail: string,
  now: Date,
): PersistedAutopilot {
  if (state.status === "stopped") return state;
  return { ...state, status: "stopped", stop: { reason, detail, at: now.toISOString() } };
}

/** Host-observable facts at the end of a turn. */
export interface AutopilotObservation {
  now: Date;
  turn: {
    /** The user pressed Esc / the run was aborted from the UI. */
    interrupted: boolean;
    /** The turn ended in a hard error (message for the stop detail). */
    error: string | null;
    /** An askcard / preflight / halt / approval card is waiting for a human. */
    awaitingHuman: boolean;
  };
  /** Host-gated: `root_status=complete` on the working ledger AND (when a native plan exists) a recorded verification pass. */
  rootComplete: boolean;
  /** Facts echoed to the model in the continuation message. */
  facts: { verification: string | null; openItems: number };
  runningJobs: number;
  /** Whether a finished worker wakes the model by itself (UI auto-wake). */
  autoWake: boolean;
  signals: AutopilotSignals;
  /** USD spent since `armedAt`; null = could not be measured (the cost cap is then not enforced). */
  spentUsd: number | null;
}

export type AutopilotDecision =
  | { action: "none" }
  | { action: "wait" }
  | { action: "continue"; prompt: string; label: string }
  | { action: "stop"; reason: AutopilotStopReason; detail: string };

/** Marker the prompt starts with, so a reloaded transcript can recognise a host-started turn. */
export const AUTOPILOT_PROMPT_TAG = "[host: /ideal autopilot";

/** The three host-observable progress signals; any difference is progress. */
export function madeProgress(
  before: AutopilotSignals,
  after: AutopilotSignals,
): { progressed: boolean; changed: string[] } {
  const changed: string[] = [];
  if (before.workspace !== after.workspace) changed.push("files");
  if (
    before.delegationsStarted !== after.delegationsStarted ||
    before.delegationsFinished !== after.delegationsFinished
  )
    changed.push("delegations");
  if (before.flow !== after.flow) changed.push("flow");
  return { progressed: changed.length > 0, changed };
}

export const AUTOPILOT_STOP_TEXT: Record<AutopilotStopReason, string> = {
  // The detail says which case applied: see completeStopDetail.
  complete: "root goal complete",
  budget_turns: "turn budget reached",
  budget_cost: "cost budget reached",
  budget_wall: "time budget reached",
  no_progress: "no progress (no file change, worker result or FLOW phase change)",
  user_message: "you sent a message",
  user_interrupt: "you interrupted the run",
  user_abort: "/ideal abort",
  needs_human: "a card is waiting for your answer",
  autowake_off: "workers are running but background auto-wake is off",
  error: "the turn ended in an error",
};

/**
 * Detail for the `complete` stop. `verification === null` means no native FLOW
 * plan was in scope, so NO verification gate applied — saying "with a recorded
 * verification pass" there was false (session 7b2886c90a51 stopped "complete"
 * while the repo's VERIFY.md said `verdict: fail`: the plan was invisible from
 * the drifted cwd, the gate saw null and accepted the claim).
 */
export function completeStopDetail(verification: string | null): string {
  return verification === "recorded_pass"
    ? "a recorded FLOW verification pass"
    : "no native FLOW plan in scope, so no verification gate applied";
}

/** `complete` is the success exit; every other reason is a halt. Maps onto the `run-finished` outcome. */
export function runFinishedOutcome(reason: AutopilotStopReason): "approved" | "halted" | "error" {
  if (reason === "complete") return "approved";
  return reason === "error" ? "error" : "halted";
}

function continuation(state: PersistedAutopilot, limits: AutopilotLimits, obs: AutopilotObservation) {
  const turn = state.turns + 1;
  const facts = [
    "root goal not recorded complete",
    obs.facts.verification ? `FLOW verification: ${obs.facts.verification}` : null,
    obs.facts.openItems > 0 ? `${obs.facts.openItems} open item(s)` : null,
    state.noProgressStreak > 0
      ? `last ${state.noProgressStreak} turn(s) changed nothing observable (stops at ${limits.noProgressTurns})`
      : null,
  ].filter(Boolean);
  return {
    prompt: `${AUTOPILOT_PROMPT_TAG}, turn ${turn}/${lim(limits.maxTurns)}] ${facts.join("; ")}. Continue the run.`,
    label: `⟲ /ideal autopilot — turn ${turn}/${lim(limits.maxTurns)}${
      obs.facts.verification && obs.facts.verification !== "recorded_pass"
        ? ` (verification: ${obs.facts.verification})`
        : ""
    }`,
  };
}

/**
 * Decide what happens after a turn of an armed run ends. Returns the next state
 * (to persist) with the decision. `continue` already counts the turn it starts.
 */
export function decideAutopilotStep(
  state: PersistedAutopilot,
  obs: AutopilotObservation,
  limits: AutopilotLimits,
): { state: PersistedAutopilot; decision: AutopilotDecision } {
  if (state.status === "stopped") return { state, decision: { action: "none" } };
  const stop = (reason: AutopilotStopReason, detail: string, base = state) => ({
    state: stopAutopilot(base, reason, detail, obs.now),
    decision: { action: "stop", reason, detail } as AutopilotDecision,
  });

  if (obs.turn.interrupted) return stop("user_interrupt", AUTOPILOT_STOP_TEXT.user_interrupt);
  if (obs.turn.error !== null) return stop("error", obs.turn.error);
  if (obs.turn.awaitingHuman) return stop("needs_human", AUTOPILOT_STOP_TEXT.needs_human);

  const { progressed } = madeProgress(state.signals, obs.signals);
  let next: PersistedAutopilot = {
    ...state,
    signals: obs.signals,
    spentUsd: obs.spentUsd ?? state.spentUsd,
    noProgressStreak: progressed ? 0 : state.noProgressStreak,
  };
  if (obs.rootComplete) return stop("complete", completeStopDetail(obs.facts.verification), next);

  if (limits.maxCostUsd !== null && obs.spentUsd !== null && obs.spentUsd >= limits.maxCostUsd)
    return stop("budget_cost", `spent $${obs.spentUsd.toFixed(2)} of $${limits.maxCostUsd.toFixed(2)}`, next);
  const elapsedMs = obs.now.getTime() - Date.parse(state.armedAt);
  if (elapsedMs >= limits.maxWallMs)
    return stop(
      "budget_wall",
      `${Math.round(elapsedMs / 60_000)} min of ${lim(Math.round(limits.maxWallMs / 60_000))} min`,
      next,
    );

  // Waiting on a worker is not a stall: only a turn that ended with nothing
  // running and nothing observable changed counts toward the no-progress rule.
  if (obs.runningJobs > 0) {
    if (!obs.autoWake)
      return stop("autowake_off", `${obs.runningJobs} worker(s) running; ${AUTOPILOT_STOP_TEXT.autowake_off}`, next);
    return { state: next, decision: { action: "wait" } };
  }

  if (!progressed) next = { ...next, noProgressStreak: next.noProgressStreak + 1 };
  if (next.noProgressStreak >= limits.noProgressTurns)
    return stop(
      "no_progress",
      `${next.noProgressStreak} consecutive turn(s) with no file change, worker result or FLOW phase change`,
      next,
    );
  if (next.turns >= limits.maxTurns)
    return stop("budget_turns", `${next.turns} of ${lim(limits.maxTurns)} turns`, next);

  const cont = continuation(next, limits, obs);
  next = { ...next, turns: next.turns + 1, totalTurns: next.totalTurns + 1 };
  return { state: next, decision: { action: "continue", ...cont } };
}

/** One-line `/ideal status` view. */
export function formatAutopilotLine(
  run: Pick<PersistedIdealRun, "autopilot">,
  limits: AutopilotLimits,
  now: Date,
): string {
  const a = run.autopilot;
  if (!a) return "Autopilot: not armed";
  const counters = `turn ${a.turns}/${lim(limits.maxTurns)}, no-progress ${a.noProgressStreak}/${limits.noProgressTurns}`;
  if (a.status === "running") {
    const min = Math.floor((now.getTime() - Date.parse(a.armedAt)) / 60_000);
    const spend = a.spentUsd === null ? "spend unmeasured" : `spent $${a.spentUsd.toFixed(2)}`;
    const cap = limits.maxCostUsd === null ? "no cost cap" : `cap $${limits.maxCostUsd.toFixed(2)}`;
    return `Autopilot: running — ${counters}, ${min}/${lim(Math.round(limits.maxWallMs / 60_000))} min, ${spend} (${cap})`;
  }
  const stop = a.stop;
  return `Autopilot: stopped (${stop?.reason ?? "unknown"}) — ${stop ? `${AUTOPILOT_STOP_TEXT[stop.reason]}${stop.detail && stop.detail !== AUTOPILOT_STOP_TEXT[stop.reason] ? `: ${stop.detail}` : ""}` : "no reason recorded"} · ${counters}${
    stop && stop.reason !== "complete" ? ". /ideal resume re-arms it" : ""
  }`;
}
