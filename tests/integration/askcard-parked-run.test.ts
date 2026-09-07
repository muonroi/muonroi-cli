/**
 * askcard-parked-run.test.ts — spawn-based regression net for the THREE
 * behaviours a run parked on a council askcard must keep, whatever else
 * changes about cancellation.
 *
 * ## Why this file exists, and why here
 *
 * A run that stops on a council askcard is the one place where a keystroke can
 * destroy work that took minutes to produce. Two of the three rows below are
 * incidents this repo has already lived through, not hypotheticals:
 *
 *  - **D1** — 2026-07-06: a dismissal ALSO fired the Stage 2 abort and wiped the
 *    whole debate transcript. The comment recording it is still at
 *    `src/ui/use-app-logic.tsx:3845-3850`.
 *  - **D3** — session `d22397a9e47d`: a 120 s idle watchdog counted a human's
 *    reading time as "no output" and discarded ~20.5 min of council work.
 *    `holdWatchdogOpen()` exists because of it.
 *
 * Neither is observable from inside the process: they are about what a spawned
 * TUI does with a key, so this file spawns the real agent-mode TUI, drives it to
 * a parked card over the harness sidechannel, and reads the event stream.
 *
 * **Placement is load-bearing.** `vitest.config.ts:57-59` excludes
 * `tests/harness/**` from the main config, so an equivalent spec there would
 * never run under `bunx vitest run` — and `bunx vitest run` IS the repo's `test`
 * script, which `src/verify/recipes.ts:263-264` folds into the sprint verifier's
 * deterministic floor. `tests/integration/**` is the set that floor actually
 * executes.
 *
 * ## What it pins — and what it deliberately does NOT
 *
 * It pins ONE direction only: **a gesture that is not a cancellation request
 * must leave the parked run alive.** Three gestures, three ways of not being a
 * cancellation:
 *
 *   D1  one Escape          → dismiss the card, the loop moves on
 *   D2  Enter               → answer the card, the loop moves on
 *   D3  nothing at all      → the card stays parked
 *
 * It says NOTHING about what a REPEATED Escape should do — at any spacing, in
 * any batching, after any delay. That direction is deliberately left unpinned:
 * today exactly one exit works (two Escapes delivered in the same input batch)
 * and no human or MCP driver can produce that delivery, so it is an open design
 * question. A test that encoded an answer here would be asserting a decision
 * this file has no standing to make, and would pre-empt whoever implements it.
 *
 * Also deliberately unpinned: the same-batch exit that DOES work today. It lives
 * in the must-END direction, which `scripts/agent-drivability-score.ts --a9`
 * already measures live against the real TUI (row K2); duplicating it here would
 * cost a fourth cold spawn to re-observe something a live measurement already
 * covers, and would freeze an input-batching detail a fix may legitimately
 * restructure.
 *
 * The rows mirror the must-stay half of the A9 matrix in
 * `scripts/agent-drivability-score.ts` (K1 → D1, K6 → D2, K5 → D3). The referee
 * is the measuring instrument and is deliberately NOT imported — it must not
 * share a module with the thing it measures — so the drive recipe is
 * transcribed here instead.
 *
 * ## Anti-vacuous-pass guards
 *
 * Every row first PROVES it reached the parked state (`askcard-open` on the
 * event stream AND an `id=askcard` node in the frame) before its gesture is
 * sent, and a row that never parked FAILS rather than passing quietly. Without
 * that, deleting the clarify phase, the askcard, or `--force-council` routing
 * would turn every assertion below green.
 *
 * ## Cost, and what was traded for it
 *
 * Three cold `bun` spawns, started together from a single `beforeAll`, so the
 * wall clock is one boot plus the LONGEST observation window rather than the
 * sum. Measured cost is in the describe block's timeout.
 *
 * Traded away, knowingly:
 *  - the must-end rows (K2/K3/K4) — a fourth spawn for a direction `--a9`
 *    measures live, see above;
 *  - D3's window is {@link WINDOW_QUIET_MS}, not the referee's 20 s. It catches
 *    a timer that ends a parked run inside that window; a watchdog with a longer
 *    fuse (the 120 s one from `d22397a9e47d`, say) is NOT caught here and is
 *    left to `--a9`.
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnAgentTui } from "../../src/agent-harness/test-spawn.js";

const MODULE = "askcard-parked-run.test";

/**
 * Tree to drive. Defaults to this repo. The override exists ONLY to run this
 * net against a deliberately-broken throwaway copy, to prove the rows below
 * actually go red on the regression they name — the same escape hatch
 * `--a9-repo-root` gives the referee. It cannot make a row pass that would
 * otherwise fail: it only changes which `src/index.ts` is spawned.
 */
const TREE_ROOT = resolve(process.env["MUONROI_ASKCARD_NET_TREE_ROOT"] ?? ".");
const ENTRY = join(TREE_ROOT, "src/index.ts");

/**
 * Reused verbatim from `tests/harness/askcard.spec.ts`, which is where this
 * fixture was built and is the reason a council askcard is reachable
 * deterministically at all. Its wildcard `responses` entry answers every council
 * call with one clarification question, so the loop parks on the first card in
 * about a second regardless of how many calls precede it. Read the fixture's own
 * `___how_the_card_appears` note before changing anything here.
 */
const FIXTURES = resolve("tests/harness/fixtures/llm-askcard");

/** Cold `bun` transpile of the whole entry graph, plus the harness handshake. */
const BOOT_TIMEOUT_MS = 120_000;
/** Budget for `/ideal` to reach the first clarification card once submitted. */
const REACH_TIMEOUT_MS = 60_000;
/** Observation window for a row that SENDS a gesture. */
const WINDOW_GESTURE_MS = 10_000;
/** Observation window for the row that sends nothing. See the header on cost. */
const WINDOW_QUIET_MS = 15_000;

/** A literal placeholder; `--mock-llm` intercepts every call, so nothing is sent. */
const MOCK_KEY = ["muonroi", "askcard", "net", "mock", "key"].join("-");

type RowId = "D1" | "D2" | "D3";

type Row = {
  id: RowId;
  /** Keys to send once parked, in order. Empty = send nothing at all. */
  gesture: readonly string[];
  /** How long to keep observing after the gesture. */
  windowMs: number;
};

const ROWS: readonly Row[] = [
  {
    id: "D1",
    gesture: ["Escape"],
    windowMs: WINDOW_GESTURE_MS,
  },
  {
    id: "D2",
    gesture: ["Enter"],
    windowMs: WINDOW_GESTURE_MS,
  },
  {
    id: "D3",
    gesture: [],
    windowMs: WINDOW_QUIET_MS,
  },
];

/** Everything a row asserts over. Raw observables only — no verdicts. */
type RowObservation = {
  /** false when the spawn itself failed; `error` says why. */
  ran: boolean;
  /** false when the run never parked on a card — a broken measurement. */
  reached: boolean;
  /** Event kinds seen AFTER the gesture was sent, in order. */
  kindsAfter: string[];
  /** `outcome` off a `run-finished` inside the window; null when none arrived. */
  runFinishedOutcome: string | null;
  runFinished: boolean;
  askcardCancelCount: number;
  answered: boolean;
  /** A further `askcard-open` or `council-step` arrived — the loop moved on. */
  advanced: boolean;
  /** An `id=askcard` node was present in the last frame at the end of the window. */
  cardOpen: boolean;
  /** The child process was still running at the end of the window. */
  alive: boolean;
  error: string | null;
  /** Child stderr tail, so a broken measurement is diagnosable in the failure. */
  stderrTail: string;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function eventKind(e: LiveEvent): string | null {
  const k = (e as { kind?: unknown }).kind;
  return typeof k === "string" ? k : null;
}

function deadRow(error: string, stderrTail = ""): RowObservation {
  return {
    ran: false,
    reached: false,
    kindsAfter: [],
    runFinishedOutcome: null,
    runFinished: false,
    askcardCancelCount: 0,
    answered: false,
    advanced: false,
    cardOpen: false,
    alive: false,
    error,
    stderrTail,
  };
}

/**
 * Spawn one agent-mode TUI, drive it to a parked council askcard, send the
 * row's gesture, and observe for `row.windowMs`.
 *
 * The wiring below is the same three primitives `tests/harness/helpers.ts` uses
 * (`spawnAgentTui` + `createDriver` + `createLineSplitter`); it is written out
 * here rather than reusing `spawnHarness` for two reasons this file needs and
 * that helper cannot give: an ordered event array with a MARK taken at the
 * instant the gesture is sent (the driver's ring replays from the beginning, so
 * "after the gesture" is not expressible through it), and a captured — rather
 * than echoed — child stderr, since three concurrent children would otherwise
 * interleave their boot logs into the suite's own output.
 */
async function runRow(row: Row, cwd: string): Promise<RowObservation> {
  const argv = [
    ENTRY,
    "--agent-mode",
    "--mock-llm",
    FIXTURES,
    "-k",
    MOCK_KEY,
    // Pinned so the child's active provider is known and its key is seeded
    // below; without a key the onboarding modal steals composer focus.
    "-m",
    "deepseek-v4-flash",
  ];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The child's own profile: its own settings, its own session DB. Also the
    // cwd, which /ideal's discover phase scans — a fresh empty dir is what keeps
    // that scan instant instead of walking this (large) repo.
    HOME: cwd,
    USERPROFILE: cwd,
    MUONROI_INTERNAL_SHIM_OK: "1",
    ANTHROPIC_API_KEY: MOCK_KEY,
    OPENAI_API_KEY: MOCK_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: MOCK_KEY,
    DEEPSEEK_API_KEY: MOCK_KEY,
    SILICONFLOW_API_KEY: MOCK_KEY,
  };

  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  const events: LiveEvent[] = [];
  let stderr = "";

  try {
    const spawned = await spawnAgentTui(argv, {
      spawnOpts: { env, cwd },
      handshakeTimeoutMs: BOOT_TIMEOUT_MS,
    });
    proc = spawned.proc;
    cleanup = spawned.cleanup;

    driver = createDriver({
      sendKey: (k) => spawned.inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
      sendType: (t) => spawned.inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
    });

    const splitter = createLineSplitter((line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        // A truncated or non-JSON sidechannel line is not fatal — the next frame
        // supersedes it — but a stream that produces them constantly would
        // otherwise look like a silent hang, so say so once per line.
        console.error(
          `[${MODULE}] ${row.id}: unparseable sidechannel line (${
            err instanceof Error ? err.message : String(err)
          }): ${line.slice(0, 200)}`,
        );
        return;
      }
      if (msg["mode"] === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg["t"] === "idle") {
        driver._ingest({ kind: "idle" });
      } else if (msg["t"] === "event") {
        const ev = msg as unknown as LiveEvent;
        events.push(ev);
        driver._ingest({ kind: "event", event: ev });
      }
    });
    spawned.outRead.on("data", (chunk: Buffer | string) => {
      splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${MODULE}] ${row.id}: spawning the agent-mode TUI failed: ${message}`, {
      entry: ENTRY,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return deadRow(`spawn failed: ${message}`, stderr);
  }

  const teardown = () => {
    try {
      proc.kill();
    } catch (err) {
      console.error(`[${MODULE}] ${row.id}: child kill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      cleanup();
    } catch (err) {
      console.error(
        `[${MODULE}] ${row.id}: transport cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ---- reach the parked state ------------------------------------------------
  try {
    await driver.wait_for({ idle: true, timeoutMs: BOOT_TIMEOUT_MS });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 30_000 });
    driver.type("/ideal build a counter --max-sprints 1 --force-council");
    await driver.wait_for({ idle: true, timeoutMs: 30_000 });
    driver.press("Enter");
    await driver.wait_for({ event: "askcard-open", timeoutMs: REACH_TIMEOUT_MS });
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 30_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${MODULE}] ${row.id}: never reached the parked state: ${message}`);
    console.error(`[${MODULE}] ${row.id}: child stderr tail:\n${stderr}`);
    teardown();
    return { ...deadRow(`never reached the parked state: ${message}`, stderr), ran: true };
  }

  // ---- gesture, then observe -------------------------------------------------
  const mark = events.length;
  for (const key of row.gesture) driver.press(key);
  await sleep(row.windowMs);

  const after = events.slice(mark);
  const kindsAfter = after.map(eventKind).filter((k): k is string => k !== null);
  const finished = after.find((e) => eventKind(e) === "run-finished");
  const outcome = (finished as { outcome?: unknown } | undefined)?.outcome;

  const observation: RowObservation = {
    ran: true,
    reached: true,
    kindsAfter,
    runFinished: finished !== undefined,
    runFinishedOutcome: typeof outcome === "string" ? outcome : null,
    askcardCancelCount: kindsAfter.filter((k) => k === "askcard-cancel").length,
    answered: kindsAfter.includes("askcard-answered"),
    advanced: kindsAfter.some((k) => k === "askcard-open" || k === "council-step"),
    cardOpen: driver.query("id=askcard") !== null,
    alive: proc.exitCode === null && proc.signalCode === null,
    error: null,
    stderrTail: stderr,
  };

  teardown();
  return observation;
}

/** Shared preamble for every assertion, so a failure names the row and its evidence. */
function evidence(id: RowId, o: RowObservation): string {
  return (
    `row ${id}: events after the gesture = [${o.kindsAfter.join(", ")}]; ` +
    `runFinished=${o.runFinished} outcome=${String(o.runFinishedOutcome)} ` +
    `cancels=${o.askcardCancelCount} answered=${o.answered} advanced=${o.advanced} ` +
    `cardOpen=${o.cardOpen} alive=${o.alive}`
  );
}

describe("a run parked on a council askcard survives every non-cancelling gesture", () => {
  const results = new Map<RowId, RowObservation>();
  let root: string | null = null;

  beforeAll(
    async () => {
      if (process.env["MUONROI_ASKCARD_NET_TREE_ROOT"]) {
        console.error(
          `[${MODULE}] NOTE: driving ${TREE_ROOT}, NOT this repo. That is only ever legitimate for a negative control ` +
            "against a deliberately-broken copy; a green run here is not evidence about this tree.",
        );
      }
      root = mkdtempSync(join(tmpdir(), "muonroi-askcard-net-"));
      const settled = await Promise.all(
        ROWS.map(async (row) => {
          const cwd = join(root as string, row.id);
          mkdirSync(cwd, { recursive: true });
          return [row.id, await runRow(row, cwd)] as const;
        }),
      );
      for (const [id, o] of settled) results.set(id, o);
    },
    BOOT_TIMEOUT_MS + REACH_TIMEOUT_MS + WINDOW_QUIET_MS + 60_000,
  );

  afterAll(() => {
    if (!root) return;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal: a leaked temp dir must not fail the suite. Still logged so a
      // machine that leaks one every run is diagnosable.
      console.error(
        `[${MODULE}] temp dir cleanup failed (${root}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  /**
   * Guard shared by all three rows: the observation is only about the TUI if the
   * run actually parked. A row that failed to spawn, or that never reached the
   * card, fails here rather than sailing through the assertions below on an
   * all-zero observation.
   */
  function parked(id: RowId): RowObservation {
    const o = results.get(id);
    expect(o, `row ${id} never ran`).toBeDefined();
    const obs = o as RowObservation;
    expect(
      obs.ran && obs.reached,
      `row ${id} produced no usable observation (${String(obs.error)}). That is a broken measurement, not a ` +
        `finding: the run must park on a council askcard before any gesture means anything.\n` +
        `child stderr tail:\n${obs.stderrTail}`,
    ).toBe(true);
    return obs;
  }

  it("D1 — one Escape dismisses the card; the run stays alive and moves on", () => {
    const o = parked("D1");

    // The regression this row exists for: 2026-07-06, a dismissal also fired the
    // Stage 2 abort and destroyed the whole debate transcript.
    expect(
      o.runFinished,
      `${evidence("D1", o)}\nThe run was ENDED by a single Escape. One Escape is the dismiss gesture: it means "not ` +
        `this question", not "throw the run away". This is the live-verified 2026-07-06 regression recorded at ` +
        `src/ui/use-app-logic.tsx:3845-3850, where the whole debate transcript went with it. Nothing here says what ` +
        `a REPEATED Escape should do — only that the first one must not be fatal.`,
    ).toBe(false);

    expect(o.alive, `${evidence("D1", o)}\nThe child process died on a dismissal.`).toBe(true);

    // Proves the key was actually delivered and consumed as a dismissal — without
    // this, a build that ignored Escape entirely would also pass the two above.
    expect(
      o.askcardCancelCount,
      `${evidence("D1", o)}\nExpected exactly one askcard-cancel: the Escape must reach the card and dismiss it. ` +
        `Zero means the key was never delivered or was swallowed, which makes the assertions above vacuous.`,
    ).toBe(1);

    // And the loop must actually carry on afterwards, not sit dead with the card
    // gone — "dismissed" without "advanced" is a stall wearing a dismissal's face.
    expect(
      o.advanced,
      `${evidence("D1", o)}\nThe card was dismissed but the loop never produced another askcard-open or ` +
        `council-step. A dismissal must return control to the run, not strand it.`,
    ).toBe(true);
  });

  it("D2 — Enter answers the card; the run stays alive and moves on", () => {
    const o = parked("D2");

    // Anti-gaming in the other direction: an over-broad "any keypress cancels"
    // must score worse, not better.
    expect(
      o.runFinished,
      `${evidence("D2", o)}\nAnswering the card ENDED the run. Enter is the ordinary path — the agent answers and ` +
        `the loop continues with that answer. If any keypress can end a parked run, answering and cancelling are no ` +
        `longer distinguishable.`,
    ).toBe(false);

    expect(o.alive, `${evidence("D2", o)}\nThe child process died on an answer.`).toBe(true);

    expect(
      o.answered,
      `${evidence("D2", o)}\nExpected an askcard-answered event: Enter must submit the selected option. Without it ` +
        `the assertions above are vacuous — a build that ignored Enter would pass them too.`,
    ).toBe(true);

    expect(
      o.advanced,
      `${evidence("D2", o)}\nThe card was answered but the loop never produced another askcard-open or ` +
        `council-step. An answer must be consumed by the run, not dropped.`,
    ).toBe(true);
  });

  it("D3 — with no input at all, the card stays parked and the run stays alive", () => {
    const o = parked("D3");

    // The d22397a9e47d incident: a timer counted a human's reading time as "no
    // output" and discarded ~20.5 min of council work.
    expect(
      o.runFinished,
      `${evidence("D3", o)}\nThe run ended with NO gesture at all — something is ending parked runs on a timer. A ` +
        `human-wait card must wait for the human; session d22397a9e47d discarded ~20.5 min of council work exactly ` +
        `this way, which is why holdWatchdogOpen() exists. This row only sees timers shorter than ` +
        `${WINDOW_QUIET_MS} ms; a longer fuse is left to the A9 referee.`,
    ).toBe(false);

    expect(o.alive, `${evidence("D3", o)}\nThe child process died while simply sitting on a card.`).toBe(true);

    expect(
      o.cardOpen,
      `${evidence("D3", o)}\nThe id=askcard node is gone after ${WINDOW_QUIET_MS} ms of no input. Nobody dismissed ` +
        `it, nobody answered it — a parked card must stay on screen until a gesture moves it.`,
    ).toBe(true);

    // No gesture was sent, so the card must not have been consumed either way.
    expect(
      o.askcardCancelCount === 0 && !o.answered,
      `${evidence("D3", o)}\nThe card was cancelled or answered with no key sent at all.`,
    ).toBe(true);
  });
});
