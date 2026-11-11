/**
 * IdealAutopilotHost: state persistence with the run record, resume, events, and
 * "the user always wins" — with fake collaborators, no model and no TUI.
 */
import { describe, expect, it } from "vitest";
import { type AutopilotSignals, resolveAutopilotConfig } from "../ideal-autopilot.js";
import { type IdealAutopilotDeps, IdealAutopilotHost, type RootCompletion } from "../ideal-autopilot-host.js";
import type { IdealCoordinationRun, IdealJob } from "../ideal-coordination.js";

const sig = (over: Partial<AutopilotSignals> = {}): AutopilotSignals => ({
  workspace: "w0",
  delegationsStarted: 0,
  delegationsFinished: 0,
  flow: "f0",
  ...over,
});

interface World {
  store: { run: IdealCoordinationRun | null };
  events: Array<Record<string, unknown>>;
  clock: { now: Date };
  jobs: IdealJob[];
  completion: RootCompletion;
  signals: AutopilotSignals;
  spent: number | null;
  autoWake: boolean;
  env: NodeJS.ProcessEnv;
  gate?: Promise<void>;
  jobsError?: Error;
}

function world(over: Partial<World> = {}): World {
  return {
    store: { run: null },
    events: [],
    clock: { now: new Date("2026-11-09T10:00:00.000Z") },
    jobs: [],
    completion: { complete: false, verification: "missing", openItems: 1 },
    signals: sig(),
    spent: 0,
    autoWake: true,
    env: {},
    ...over,
  };
}

function host(w: World, store = w.store): IdealAutopilotHost {
  const deps: IdealAutopilotDeps = {
    cwd: () => "/work",
    sessionId: () => "sess-1",
    readRun: () => (store.run ? structuredClone(store.run) : null),
    writeRun: (run) => {
      store.run = run ? structuredClone(run) : null;
      return true;
    },
    jobs: async () => {
      if (w.jobsError) throw w.jobsError;
      return w.jobs;
    },
    rootCompletion: async () => w.completion,
    collectSignals: async () => {
      await w.gate;
      return w.signals;
    },
    spentSince: async () => w.spent,
    config: () => resolveAutopilotConfig(w.env, undefined),
    autoWake: () => w.autoWake,
    emit: (e) => w.events.push(e),
    now: () => w.clock.now,
    log: { info() {}, warn() {}, error() {} },
  };
  return new IdealAutopilotHost(deps);
}

const RUN: IdealCoordinationRun = { goal: "build it", startedAt: "2026-11-09T10:00:00.000Z" };
const kinds = (w: World) => w.events.map((e) => `${e.kind}:${e.action ?? e.outcome}`);

describe("arming and persistence", () => {
  it("arm saves the autopilot state in the run record and announces start", async () => {
    const w = world();
    const armed = await host(w).arm(RUN);
    expect(w.store.run?.autopilot).toMatchObject({ status: "running", turns: 0, totalTurns: 0 });
    expect(armed.goal).toBe("build it");
    expect(kinds(w)).toEqual(["ideal-autopilot:start"]);
  });

  it("with MUONROI_IDEAL_AUTOPILOT=0 the run is saved without any autopilot and never continues", async () => {
    const w = world({ env: { MUONROI_IDEAL_AUTOPILOT: "0" } });
    const h = host(w);
    await h.arm(RUN);
    expect(w.store.run).toEqual(RUN);
    expect(await h.afterTurn({})).toEqual({ action: "none" });
    expect(h.isRunning()).toBe(false);
    expect(w.events).toEqual([]);
    expect(h.statusLine(w.store.run!, w.clock.now)).toContain("off");
  });

  it("each continuation is persisted; a restarted host (same record) carries on from the saved counters", async () => {
    const w = world();
    const h1 = host(w);
    await h1.arm(RUN);
    w.signals = sig({ workspace: "w1" });
    expect(await h1.afterTurn({})).toMatchObject({ action: "continue" });
    w.signals = sig({ workspace: "w2" });
    expect(await h1.afterTurn({})).toMatchObject({ action: "continue" });
    expect(w.store.run?.autopilot).toMatchObject({ turns: 2, totalTurns: 2, status: "running" });

    // CLI restart: a new host over the persisted record.
    const h2 = host(world({ store: w.store, signals: sig({ workspace: "w3" }) }), w.store);
    expect(h2.isRunning()).toBe(true);
    const w2 = world({ store: w.store, signals: sig({ workspace: "w3" }) });
    const decision = await host(w2, w.store).afterTurn({});
    expect(decision).toMatchObject({ action: "continue" });
    expect(w.store.run?.autopilot).toMatchObject({ turns: 3, totalTurns: 3 });
  });

  it("resume re-arms a stopped run: new budget window, total turns kept, stop cleared", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    w.signals = sig({ workspace: "w1" });
    await h.afterTurn({});
    await h.afterTurn({ error: "provider down" });
    expect(w.store.run?.autopilot).toMatchObject({ status: "stopped", stop: { reason: "error" } });
    w.clock.now = new Date("2026-11-09T12:00:00.000Z");
    await h.arm(w.store.run!, w.store.run!.autopilot);
    expect(w.store.run?.autopilot).toMatchObject({
      status: "running",
      turns: 0,
      totalTurns: 1,
      armedAt: "2026-11-09T12:00:00.000Z",
    });
    expect(w.store.run?.autopilot?.stop).toBeUndefined();
  });
});

describe("events", () => {
  it("continue and wait are announced; a completed run ends with stop + run-finished outcome=approved", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    w.signals = sig({ workspace: "w1" });
    await h.afterTurn({});
    w.jobs = [{ id: "j1", agent: "general", description: "d", status: "running", startedAt: RUN.startedAt }];
    await h.afterTurn({});
    w.jobs = [{ ...w.jobs[0]!, status: "complete" }];
    w.completion = { complete: true, verification: "recorded_pass", openItems: 0 };
    const done = await h.afterTurn({});
    expect(done).toMatchObject({ action: "stop", reason: "complete" });
    expect(kinds(w)).toEqual([
      "ideal-autopilot:start",
      "ideal-autopilot:continue",
      "ideal-autopilot:wait",
      "ideal-autopilot:stop",
      "run-finished:approved",
    ]);
    const fin = w.events.at(-1)!;
    expect(fin).toMatchObject({ success: true, reason: "complete", runId: "sess-1" });
    expect(w.events[3]).toMatchObject({ reason: "complete", turn: 1 });
    // After a stop nothing else happens, and nothing is announced twice.
    expect(await h.afterTurn({})).toEqual({ action: "none" });
    expect(w.events).toHaveLength(5);
  });

  it("a non-complete stop is run-finished outcome=halted; a hard error is outcome=error", async () => {
    const quiet = world();
    const hq = host(quiet);
    await hq.arm(RUN);
    for (let i = 0; i < 3; i++) await hq.afterTurn({});
    expect(quiet.events.at(-1)).toMatchObject({ kind: "run-finished", outcome: "halted", reason: "no_progress" });

    const bad = world();
    const hb = host(bad);
    await hb.arm(RUN);
    await hb.afterTurn({ error: "401" });
    expect(bad.events.at(-1)).toMatchObject({ kind: "run-finished", outcome: "error", reason: "error" });
  });

  it("a watchdog-killed turn (transient) continues and persists the streak; a hard error with the same text stops", async () => {
    const stallText = "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung";
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    w.signals = sig({ workspace: "w1" });
    expect(await h.afterTurn({ error: stallText, transient: true })).toMatchObject({ action: "continue" });
    expect(w.store.run?.autopilot).toMatchObject({ status: "running", transientErrorStreak: 1 });

    const hard = world();
    const hh = host(hard);
    await hh.arm(RUN);
    expect(await hh.afterTurn({ error: stallText })).toMatchObject({ action: "stop", reason: "error" });
  });

  it("needs_human: a pending card stops the run without answering it", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    expect(await h.afterTurn({ awaitingHuman: true })).toMatchObject({ action: "stop", reason: "needs_human" });
  });

  it("an unreadable delegation ledger is a hard error, not a silent continue", async () => {
    const w = world({ jobsError: new Error("ledger io") });
    const h = host(w);
    await h.arm(RUN); // arming tolerates it (logged); the turn-end evaluation does not
    expect(await h.afterTurn({})).toMatchObject({ action: "stop", reason: "error" });
  });
});

describe("the user always wins", () => {
  it("typing or Esc stops a running autopilot at once and durably; the next evaluation does nothing", async () => {
    for (const reason of ["user_message", "user_interrupt"] as const) {
      const w = world();
      const h = host(w);
      await h.arm(RUN);
      h.yieldTo(reason);
      expect(h.isRunning()).toBe(false);
      expect(w.store.run?.autopilot).toMatchObject({ status: "stopped", stop: { reason } });
      expect(await h.afterTurn({})).toEqual({ action: "none" });
      expect(kinds(w)).toEqual(["ideal-autopilot:start", "ideal-autopilot:stop", "run-finished:halted"]);
    }
  });

  it("a user action landing while the host is still measuring cancels the continuation", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    let release!: () => void;
    w.gate = new Promise<void>((r) => {
      release = r;
    });
    w.signals = sig({ workspace: "changed" });
    const pending = h.afterTurn({});
    h.yieldTo("user_message"); // the user types while collectSignals is awaiting
    release();
    expect(await pending).toEqual({ action: "none" });
    expect(w.store.run?.autopilot).toMatchObject({ status: "stopped", turns: 0, stop: { reason: "user_message" } });
    expect(kinds(w)).not.toContain("ideal-autopilot:continue");
  });

  it("yielding is idempotent and a no-op without an armed autopilot", async () => {
    const w = world();
    const h = host(w);
    h.yieldTo("user_message"); // no run
    await h.arm(RUN);
    h.yieldTo("user_message");
    h.yieldTo("user_interrupt");
    expect(w.store.run?.autopilot?.stop?.reason).toBe("user_message");
    expect(w.events.filter((e) => e.action === "stop")).toHaveLength(1);
  });

  it("/ideal abort: the yield is persisted before the record is closed", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    h.yieldTo("user_abort");
    expect(w.store.run?.autopilot).toMatchObject({ status: "stopped", stop: { reason: "user_abort" } });
    expect(await h.afterTurn({})).toEqual({ action: "none" });
  });
});

describe("status line", () => {
  it("renders running and stopped states from the persisted record", async () => {
    const w = world();
    const h = host(w);
    await h.arm(RUN);
    expect(h.statusLine(w.store.run!, w.clock.now)).toContain("Autopilot: running");
    h.yieldTo("user_message");
    const line = h.statusLine(w.store.run!, w.clock.now)!;
    expect(line).toContain("stopped (user_message)");
    expect(line).toContain("you sent a message");
  });
});
