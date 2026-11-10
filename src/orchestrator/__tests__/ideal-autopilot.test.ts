/**
 * Host autopilot policy for an orchestrator-role `/ideal` run — one test per stop
 * condition, the precedence between them, and the config knobs.
 *
 * Evidence for the design: session 55c5b65b6938 finished its work (545/545 tests)
 * but never closed, because after every turn the host waited for a human
 * "continue" (see the module header of ideal-autopilot.ts).
 */
import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_DEFAULTS,
  AUTOPILOT_PROMPT_TAG,
  AUTOPILOT_STOP_TEXT,
  type AutopilotLimits,
  type AutopilotObservation,
  type AutopilotSignals,
  armAutopilot,
  decideAutopilotStep,
  formatAutopilotLine,
  MAX_TRANSIENT_ERROR_RETRIES,
  madeProgress,
  type PersistedAutopilot,
  resolveAutopilotConfig,
  runFinishedOutcome,
  stopAutopilot,
} from "../ideal-autopilot.js";

const T0 = new Date("2026-11-09T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const sig = (over: Partial<AutopilotSignals> = {}): AutopilotSignals => ({
  workspace: "w0",
  delegationsStarted: 0,
  delegationsFinished: 0,
  flow: "plan|unverified|missing|-|-",
  ...over,
});
const limits: AutopilotLimits = { maxTurns: 5, maxCostUsd: null, maxWallMs: 60 * 60_000, noProgressTurns: 3 };
const fresh = () => armAutopilot({ now: T0, signals: sig() });
const obs = (over: Partial<AutopilotObservation> = {}): AutopilotObservation => ({
  now: at(1),
  turn: { interrupted: false, error: null, awaitingHuman: false },
  rootComplete: false,
  facts: { verification: "missing", openItems: 2 },
  runningJobs: 0,
  autoWake: true,
  signals: sig({ workspace: "w1" }),
  spentUsd: 0.5,
  ...over,
});
const step = (state: PersistedAutopilot, o: Partial<AutopilotObservation> = {}, l = limits) =>
  decideAutopilotStep(state, obs(o), l);

describe("continue", () => {
  it("starts the next turn with a short host-tagged instruction that states facts, not 'keep going' prose", () => {
    const { state, decision } = step(fresh());
    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") return;
    expect(decision.prompt.startsWith(AUTOPILOT_PROMPT_TAG)).toBe(true);
    expect(decision.prompt).toContain("turn 1/5");
    expect(decision.prompt).toContain("FLOW verification: missing");
    expect(decision.prompt).toContain("2 open item(s)");
    expect(decision.prompt.length).toBeLessThan(300);
    expect(decision.label).toContain("turn 1/5");
    expect(state).toMatchObject({ status: "running", turns: 1, totalTurns: 1, noProgressStreak: 0 });
  });

  it("tells the model when the last turns changed nothing, with the threshold", () => {
    let s = fresh();
    s = step(s, { signals: sig() }).state; // no change: streak 1
    const { decision } = step(s, { signals: sig() });
    expect(decision.action).toBe("continue");
    if (decision.action === "continue") expect(decision.prompt).toContain("last 2 turn(s) changed nothing");
  });
});

describe("complete stop detail names which case applied", () => {
  it("recorded pass: the detail says a FLOW verification pass was recorded", () => {
    const { decision } = step(fresh(), { rootComplete: true, facts: { verification: "recorded_pass", openItems: 0 } });
    expect(decision).toMatchObject({ action: "stop", reason: "complete" });
    if (decision.action !== "stop") return;
    expect(decision.detail).toBe("a recorded FLOW verification pass");
  });

  it("no native plan in scope (verification null): the detail does NOT claim a verification pass", () => {
    const { state, decision } = step(fresh(), { rootComplete: true, facts: { verification: null, openItems: 0 } });
    expect(decision).toMatchObject({ action: "stop", reason: "complete" });
    if (decision.action !== "stop") return;
    expect(decision.detail).toContain("no native FLOW plan in scope");
    expect(decision.detail).not.toContain("recorded");
    expect(state.stop?.detail).toBe(decision.detail);
    // The reason text alone must not assert a verification either.
    expect(AUTOPILOT_STOP_TEXT.complete).not.toContain("verification");
  });
});

describe("stop conditions", () => {
  it("complete: root goal closed with a recorded pass", () => {
    const { state, decision } = step(fresh(), { rootComplete: true });
    expect(decision).toMatchObject({ action: "stop", reason: "complete" });
    expect(state.status).toBe("stopped");
    expect(state.stop?.reason).toBe("complete");
    expect(runFinishedOutcome("complete")).toBe("approved");
  });

  it("complete wins over a budget that is also spent", () => {
    const l = { ...limits, maxCostUsd: 1 };
    expect(step(fresh(), { rootComplete: true, spentUsd: 9 }, l).decision).toMatchObject({ reason: "complete" });
  });

  it("budget_turns: the (maxTurns+1)th host-started turn is refused", () => {
    let s = fresh();
    for (let i = 1; i <= limits.maxTurns; i++) {
      const r = step(s, { signals: sig({ workspace: `w${i}` }) });
      expect(r.decision.action, `turn ${i}`).toBe("continue");
      s = r.state;
    }
    const last = step(s, { signals: sig({ workspace: "wN" }) });
    expect(last.decision).toMatchObject({ action: "stop", reason: "budget_turns" });
    expect(runFinishedOutcome("budget_turns")).toBe("halted");
  });

  it("budget_cost: spend of the window reaches the cap; unmeasurable spend is not enforced", () => {
    const l = { ...limits, maxCostUsd: 2 };
    expect(step(fresh(), { spentUsd: 2 }, l).decision).toMatchObject({ action: "stop", reason: "budget_cost" });
    expect(step(fresh(), { spentUsd: 1.99 }, l).decision.action).toBe("continue");
    expect(step(fresh(), { spentUsd: null }, l).decision.action).toBe("continue");
    expect(step(fresh(), { spentUsd: 99 }).decision.action).toBe("continue"); // no cap configured
  });

  it("budget_wall: elapsed time since the window opened reaches the cap", () => {
    expect(step(fresh(), { now: at(59) }).decision.action).toBe("continue");
    expect(step(fresh(), { now: at(60) }).decision).toMatchObject({ action: "stop", reason: "budget_wall" });
  });

  it("no_progress: N consecutive turn ends with no file, delegation or FLOW change", () => {
    let s = fresh();
    const quiet = { signals: sig() };
    for (let i = 1; i < limits.noProgressTurns; i++) {
      const r = step(s, quiet);
      expect(r.decision.action, `quiet turn ${i}`).toBe("continue");
      s = r.state;
    }
    expect(step(s, quiet).decision).toMatchObject({ action: "stop", reason: "no_progress" });
  });

  it("each progress signal alone resets the streak: files, a delegation result, a FLOW change", () => {
    const quietTwice = () => {
      let s = fresh();
      s = step(s, { signals: sig() }).state;
      s = step(s, { signals: sig() }).state;
      expect(s.noProgressStreak).toBe(2);
      return s;
    };
    for (const change of [
      sig({ workspace: "edited" }),
      sig({ delegationsStarted: 1 }),
      sig({ delegationsStarted: 1, delegationsFinished: 1 }),
      sig({ flow: "execute|verified|missing|1|-" }),
    ]) {
      const r = step(quietTwice(), { signals: change });
      expect(r.decision.action).toBe("continue");
      expect(r.state.noProgressStreak).toBe(0);
    }
    expect(madeProgress(sig(), sig()).progressed).toBe(false);
    expect(madeProgress(sig(), sig({ delegationsFinished: 1 })).changed).toEqual(["delegations"]);
  });

  it("running workers: wait (the result wakes the model); waiting is not a stall", () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) {
      const r = step(s, { runningJobs: 2, signals: sig() });
      expect(r.decision.action).toBe("wait");
      expect(r.state.noProgressStreak).toBe(0);
      expect(r.state.turns).toBe(0);
      s = r.state;
    }
  });

  it("autowake_off: workers running but their result cannot wake the model", () => {
    expect(step(fresh(), { runningJobs: 1, autoWake: false }).decision).toMatchObject({
      action: "stop",
      reason: "autowake_off",
    });
  });

  it("needs_human: a card awaits a person; the host never answers it", () => {
    const r = step(fresh(), { turn: { interrupted: false, error: null, awaitingHuman: true } });
    expect(r.decision).toMatchObject({ action: "stop", reason: "needs_human" });
  });

  it("error: a hard error ends the run and names the error", () => {
    const r = step(fresh(), { turn: { interrupted: false, error: "401 invalid api key", awaitingHuman: false } });
    expect(r.decision).toMatchObject({ action: "stop", reason: "error", detail: "401 invalid api key" });
    expect(runFinishedOutcome("error")).toBe("error");
  });

  it("transient (watchdog) error: retried up to MAX_TRANSIENT_ERROR_RETRIES, then stops; a clean turn resets the count", () => {
    // Session 876b87182b86: one stalled provider stream ended a run whose fix was already verified.
    const stall = {
      interrupted: false,
      error: "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung",
      transient: true,
      awaitingHuman: false,
    };
    let state = fresh();
    for (let i = 1; i <= MAX_TRANSIENT_ERROR_RETRIES; i++) {
      const r = step(state, { turn: stall, signals: sig({ workspace: `w${i}` }) });
      expect(r.decision.action).toBe("continue");
      expect(r.state.transientErrorStreak).toBe(i);
      if (r.decision.action === "continue") expect(r.decision.prompt).toContain("ended by the turn watchdog");
      state = r.state;
    }
    const last = step(state, { turn: stall, signals: sig({ workspace: "wz" }) });
    expect(last.decision).toMatchObject({ action: "stop", reason: "error" });
    if (last.decision.action === "stop")
      expect(last.decision.detail).toContain(`${MAX_TRANSIENT_ERROR_RETRIES + 1} consecutive watchdog-killed turns`);

    // A clean turn end between stalls resets the streak.
    const once = step(fresh(), { turn: stall }).state;
    const clean = step(once, { signals: sig({ workspace: "w9" }) });
    expect(clean.state.transientErrorStreak).toBe(0);
  });

  it("transient error still respects the other rules: complete wins, running workers wait", () => {
    const stall = { interrupted: false, error: "Turn ended by watchdog: x", transient: true, awaitingHuman: false };
    expect(step(fresh(), { turn: stall, rootComplete: true }).decision).toMatchObject({ reason: "complete" });
    expect(step(fresh(), { turn: stall, runningJobs: 1 }).decision).toEqual({ action: "wait" });
  });

  it("a non-transient error is never retried, even with a zero streak", () => {
    const r = step(fresh(), { turn: { interrupted: false, error: "boom", transient: false, awaitingHuman: false } });
    expect(r.decision).toMatchObject({ action: "stop", reason: "error", detail: "boom" });
  });

  it("user interrupt at turn end stops the run", () => {
    const r = step(fresh(), { turn: { interrupted: true, error: null, awaitingHuman: false } });
    expect(r.decision).toMatchObject({ action: "stop", reason: "user_interrupt" });
  });

  it("precedence: interrupt > error > needs_human > complete", () => {
    const all = { interrupted: true, error: "boom", awaitingHuman: true };
    expect(step(fresh(), { turn: all, rootComplete: true }).decision).toMatchObject({ reason: "user_interrupt" });
    expect(step(fresh(), { turn: { ...all, interrupted: false }, rootComplete: true }).decision).toMatchObject({
      reason: "error",
    });
    expect(
      step(fresh(), { turn: { ...all, interrupted: false, error: null }, rootComplete: true }).decision,
    ).toMatchObject({ reason: "needs_human" });
  });
});

describe("stopped state", () => {
  it("never restarts by itself and keeps its first stop reason", () => {
    const stopped = stopAutopilot(fresh(), "user_message", "typed", at(1));
    expect(step(stopped).decision).toEqual({ action: "none" });
    expect(stopAutopilot(stopped, "error", "later", at(2)).stop?.reason).toBe("user_message");
  });

  it("re-arming (resume) opens a fresh window but keeps the total turn count", () => {
    let s = fresh();
    s = step(s).state;
    s = step(s, { signals: sig({ workspace: "w2" }) }).state;
    expect(s.totalTurns).toBe(2);
    const stopped = stopAutopilot(s, "budget_turns", "x", at(5));
    const again = armAutopilot({ now: at(10), signals: sig(), previous: stopped });
    expect(again).toMatchObject({ status: "running", turns: 0, totalTurns: 2, noProgressStreak: 0, spentUsd: 0 });
    expect(again.stop).toBeUndefined();
    expect(again.armedAt).toBe(at(10).toISOString());
  });
});

describe("config", () => {
  it("defaults: turn and wall caps on, no cost cap (the standing /ideal no-spend-cap decision), enabled", () => {
    const c = resolveAutopilotConfig({}, undefined);
    expect(c.enabled).toBe(true);
    expect(c.limits).toEqual({
      maxTurns: AUTOPILOT_DEFAULTS.maxTurns,
      maxCostUsd: null,
      maxWallMs: AUTOPILOT_DEFAULTS.maxWallMinutes * 60_000,
      noProgressTurns: AUTOPILOT_DEFAULTS.noProgressTurns,
    });
  });

  it("env overrides settings; 0 means no limit for turns/wall/cost; unusable values are reported and skipped", () => {
    const settings = { maxTurns: 10, maxCostUsd: 5, maxWallMinutes: 30, noProgressTurns: 2 };
    expect(resolveAutopilotConfig({}, settings).limits).toEqual({
      maxTurns: 10,
      maxCostUsd: 5,
      maxWallMs: 30 * 60_000,
      noProgressTurns: 2,
    });
    const env = {
      MUONROI_IDEAL_AUTOPILOT_MAX_TURNS: "0",
      MUONROI_IDEAL_AUTOPILOT_MAX_COST_USD: "0",
      MUONROI_IDEAL_AUTOPILOT_MAX_WALL_MIN: "0",
      MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS: "7",
    } as NodeJS.ProcessEnv;
    const c = resolveAutopilotConfig(env, settings);
    expect(c.limits.maxTurns).toBe(Number.POSITIVE_INFINITY);
    expect(c.limits.maxCostUsd).toBeNull();
    expect(c.limits.maxWallMs).toBe(Number.POSITIVE_INFINITY);
    expect(c.limits.noProgressTurns).toBe(7);
    const bad = resolveAutopilotConfig({ MUONROI_IDEAL_AUTOPILOT_MAX_TURNS: "lots" } as NodeJS.ProcessEnv, undefined);
    expect(bad.limits.maxTurns).toBe(AUTOPILOT_DEFAULTS.maxTurns);
    expect(bad.ignored).toEqual(['MUONROI_IDEAL_AUTOPILOT_MAX_TURNS="lots"']);
  });

  it("MUONROI_IDEAL_AUTOPILOT=0 disables it (also over an enabling setting); settings can disable it too", () => {
    for (const off of ["0", "false", "off", "no"])
      expect(
        resolveAutopilotConfig({ MUONROI_IDEAL_AUTOPILOT: off } as NodeJS.ProcessEnv, { enabled: true }).enabled,
      ).toBe(false);
    expect(resolveAutopilotConfig({}, { enabled: false }).enabled).toBe(false);
    expect(
      resolveAutopilotConfig({ MUONROI_IDEAL_AUTOPILOT: "1" } as NodeJS.ProcessEnv, { enabled: false }).enabled,
    ).toBe(true);
  });
});

describe("status line", () => {
  it("shows a running autopilot with counters and budget, and a stopped one with its reason", () => {
    const running = { ...fresh(), turns: 3, noProgressStreak: 1, spentUsd: 1.234 };
    const line = formatAutopilotLine({ autopilot: running }, limits, at(12));
    expect(line).toContain("running");
    expect(line).toContain("turn 3/5");
    expect(line).toContain("no-progress 1/3");
    expect(line).toContain("12/60 min");
    expect(line).toContain("spent $1.23");
    expect(line).toContain("no cost cap");
    const stopped = stopAutopilot(running, "no_progress", "3 consecutive turn(s)", at(13));
    const stoppedLine = formatAutopilotLine({ autopilot: stopped }, limits, at(14));
    expect(stoppedLine).toContain("stopped (no_progress)");
    expect(stoppedLine).toContain("/ideal resume re-arms it");
    expect(
      formatAutopilotLine({ autopilot: stopAutopilot(running, "complete", "x", at(13)) }, limits, at(14)),
    ).not.toContain("re-arms");
    expect(formatAutopilotLine({}, limits, at(1))).toBe("Autopilot: not armed");
  });
});
