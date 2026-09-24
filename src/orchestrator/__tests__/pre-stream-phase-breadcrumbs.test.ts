/**
 * Durable pre-stream phase breadcrumbs (message-processor.ts's `preStreamPhase`
 * helper, `pre-stream.<toolEngine>` pair in tool-engine.ts, and the
 * `ensureCouncilFactory` pair in council/llm.ts).
 *
 * Session 1e9db4d68da0: the top-level 120s turn watchdog fired with ZERO
 * interaction_logs / call_accounting rows anywhere in the pre-stream window —
 * nothing said WHICH await hung. These breadcrumbs close that gap: a
 * `pre-stream.<phase>.start` line with no matching `.end` names the phase that
 * started and did not finish, which orchestrator.ts's watchdog catch reads via
 * `getLastOpenPhase(this.session?.id)` and writes into the `error`
 * interaction_log row's `data.lastPhase` field.
 *
 * These tests cover the three ends of that contract:
 *   1. A normal (resolving) phase writes a `.start` THEN a `.end` line.
 *   2. A phase that never settles leaves the trail's last line as its
 *      `.start` with no `.end` — and derives the same `lastPhase` string
 *      orchestrator.ts's watchdog catch computes.
 *   3. Attribution is PER SESSION: a nested run writing concurrently cannot
 *      shadow the run that actually hung, and a still-open outer phase is not
 *      lost behind an inner phase's `.end`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetBreadcrumbStateForTests,
  type BreadcrumbRecord,
  getLastBreadcrumb,
  getLastOpenPhase,
} from "../../council/crash-breadcrumb.js";
import { preStreamPhase } from "../message-processor.js";

let tmpDir: string;
let filePath: string;

function readLines(p = filePath): BreadcrumbRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as BreadcrumbRecord);
}

// The ORIGINAL, flat derivation: "is the trail's last record a `.start`".
// orchestrator.ts no longer computes attribution this way — it calls
// `getLastOpenPhase(sessionId)`, which tracks the OPEN SET per session so a
// nested run cannot shadow it and a still-open OUTER phase is not lost behind
// an inner `.end`. This local copy is kept deliberately: it pins the marker
// SHAPE these breadcrumbs must keep emitting, independent of the tracker, and
// the tests below assert the real function agrees with it on the flat cases.
function lastOpenPhaseFrom(record: BreadcrumbRecord | null): string | null {
  if (record && typeof record.marker === "string" && record.marker.endsWith(".start")) {
    const withoutSuffix = record.marker.slice(0, -".start".length);
    const prefix = "pre-stream.";
    return withoutSuffix.startsWith(prefix) ? withoutSuffix.slice(prefix.length) : withoutSuffix;
  }
  return null;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-prestream-breadcrumb-"));
  filePath = path.join(tmpDir, "council-breadcrumbs.jsonl");
  process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = filePath;
  delete process.env.MUONROI_COUNCIL_BREADCRUMBS;
  __resetBreadcrumbStateForTests();
});

afterEach(() => {
  delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("preStreamPhase — normal turns emit start/end breadcrumbs per phase", () => {
  it("writes a .start line then a .end line, in order, for a resolving phase", async () => {
    const result = await preStreamPhase("flowReady", "sess-1", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });

    expect(result).toBe(42);
    const lines = readLines();
    expect(lines.map((l) => l.marker)).toEqual(["pre-stream.flowReady.start", "pre-stream.flowReady.end"]);
    expect(lines[0]!.sessionId).toBe("sess-1");
    expect(lines[1]!.sessionId).toBe("sess-1");
    // The last breadcrumb is the .end — no open phase after a normal turn.
    expect(lastOpenPhaseFrom(getLastBreadcrumb())).toBeNull();
    // ...and the real tracker agrees, scoped to this session.
    expect(getLastOpenPhase("sess-1")).toBeNull();
  });

  it("still writes the .end line when the phase rejects (error path is closed too)", async () => {
    await expect(
      preStreamPhase("initOAuthProvider", "sess-2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const lines = readLines();
    expect(lines.map((l) => l.marker)).toEqual([
      "pre-stream.initOAuthProvider.start",
      "pre-stream.initOAuthProvider.end",
    ]);
    expect(lines[1]!.error).toBe("boom");
    expect(lastOpenPhaseFrom(getLastBreadcrumb())).toBeNull();
    expect(getLastOpenPhase("sess-2")).toBeNull();
  });

  it("emits a distinct start/end pair per phase across a sequence of phases", async () => {
    await preStreamPhase("flowReady", "sess-3", async () => "a");
    await preStreamPhase("initOAuthProvider", "sess-3", async () => "b");
    await preStreamPhase("consumeBackgroundNotifications", "sess-3", async () => "c");

    const markers = readLines().map((l) => l.marker);
    expect(markers).toEqual([
      "pre-stream.flowReady.start",
      "pre-stream.flowReady.end",
      "pre-stream.initOAuthProvider.start",
      "pre-stream.initOAuthProvider.end",
      "pre-stream.consumeBackgroundNotifications.start",
      "pre-stream.consumeBackgroundNotifications.end",
    ]);
  });
});

describe("preStreamPhase — a stubbed phase that never settles: the last breadcrumb names it", () => {
  it("leaves the trail's last line as the .start of the hung phase (no matching .end)", async () => {
    // Fire the phase but do NOT await it — this is exactly the shape of a
    // real hang: the promise never settles, so nothing after `fn()` starts
    // ever runs, including the `.end` breadcrumb in `preStreamPhase`'s
    // `.then()`.
    void preStreamPhase("gsdGate", "sess-hang", () => new Promise<void>(() => {}));

    // Let the microtask queue drain so the synchronous `.start` breadcrumb
    // (written before `fn()` is even awaited) has landed.
    await new Promise((r) => setTimeout(r, 10));

    const lines = readLines();
    expect(lines.map((l) => l.marker)).toEqual(["pre-stream.gsdGate.start"]);

    const last = getLastBreadcrumb();
    expect(last?.marker).toBe("pre-stream.gsdGate.start");
    // The flat derivation and the real tracker agree on this (flat) case —
    // `gsdGate` is what lands in the `error` interaction_log row's
    // `data.lastPhase` field.
    expect(lastOpenPhaseFrom(last)).toBe("gsdGate");
    expect(getLastOpenPhase("sess-hang")).toBe("gsdGate");
  });

  it("a later phase's breadcrumb does not retroactively close an earlier hung phase", async () => {
    void preStreamPhase("routerDecide", "sess-hang-2", () => new Promise<void>(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    // Even if some OTHER, unrelated phase starts afterward (e.g. a nested
    // call elsewhere in the process), the hung phase's `.start` is still the
    // one immediately preceding it in the trail.
    const linesBefore = readLines();
    expect(linesBefore).toHaveLength(1);
    expect(linesBefore[0]!.marker).toBe("pre-stream.routerDecide.start");
    // The nested/concurrent shadowing this comment used to call a documented
    // limitation is now closed by per-session attribution — see the
    // "per-session attribution" describe below and `getLastOpenPhase`.
    expect(getLastOpenPhase("sess-hang-2")).toBe("routerDecide");
  });
});

/**
 * The defect this describe closes.
 *
 * `getLastBreadcrumb()` with no argument is a PROCESS-GLOBAL tail, so a nested
 * run — a forked sub-session (`SPAWN_SUB_SESSION` in orchestrator.ts) or an
 * `/ideal` sprint — writes its own breadcrumbs into the same single slot and
 * shadows the run that actually hung. The parent's watchdog then names a phase
 * the CHILD was in, and a WRONG attribution is worse than none: this row exists
 * precisely because session 1e9db4d68da0 was killed with no other evidence.
 */
describe("per-session attribution — a nested run cannot shadow the run that hung", () => {
  it("names the PARENT's open phase even though a child session wrote the last line", async () => {
    // The real shape: `pre-stream.subSessionSpawn` stays open on the parent
    // while the forked child runs a whole turn of its own phases.
    void preStreamPhase("subSessionSpawn", "parent-1", () => new Promise<void>(() => {}));
    await new Promise((r) => setTimeout(r, 5));

    await preStreamPhase("pilPrep", "child-1", async () => "a");
    await preStreamPhase("routerDecide", "child-1", async () => "b");
    await preStreamPhase("toolEngine", "child-1", async () => "c");

    // The process-global tail IS the child's last line — that is the shadowing.
    expect(getLastBreadcrumb()?.marker).toBe("pre-stream.toolEngine.end");
    expect(getLastBreadcrumb()?.sessionId).toBe("child-1");

    // The parent's own tail and its attribution are untouched by the child.
    expect(getLastBreadcrumb("parent-1")?.marker).toBe("pre-stream.subSessionSpawn.start");
    expect(getLastOpenPhase("parent-1")).toBe("subSessionSpawn");
    // The child closed every phase it opened, so it has nothing open.
    expect(getLastOpenPhase("child-1")).toBeNull();
  });

  it("a completed parent phase attributes to null, not a stale phase name", async () => {
    await preStreamPhase("routerDecide", "parent-2", async () => "done");
    await preStreamPhase("pilPrep", "child-2", async () => new Promise((r) => setTimeout(() => r("x"), 5)));

    expect(getLastBreadcrumb("parent-2")?.marker).toBe("pre-stream.routerDecide.end");
    expect(getLastOpenPhase("parent-2")).toBeNull();
  });

  it("names the still-open OUTER phase when the session's last line is an inner .end", async () => {
    // Nesting within ONE session: `pre-stream.toolEngine` brackets the whole
    // stream (tool-engine.ts:727/:2094) while `ensureCouncilFactory`
    // (council/llm.ts:128/:136) opens and closes inside it. The session's last
    // record is then the inner `.end`, yet `toolEngine` is genuinely still open
    // — "is the last record a .start" would answer null and lose the hang.
    let releaseOuter: () => void = () => {};
    const outer = preStreamPhase("toolEngine", "parent-3", () => {
      return new Promise<void>((r) => {
        releaseOuter = r;
      });
    });
    await new Promise((r) => setTimeout(r, 5));
    await preStreamPhase("ensureCouncilFactory", "parent-3", async () => "inner");

    expect(getLastBreadcrumb("parent-3")?.marker).toBe("pre-stream.ensureCouncilFactory.end");
    expect(getLastOpenPhase("parent-3")).toBe("toolEngine");

    // Closing the outer phase clears the attribution — nothing is left open.
    releaseOuter();
    await outer;
    expect(getLastOpenPhase("parent-3")).toBeNull();
  });

  it("an unknown session attributes to null rather than borrowing another run's phase", async () => {
    void preStreamPhase("gsdGate", "someone-else", () => new Promise<void>(() => {}));
    await new Promise((r) => setTimeout(r, 5));

    expect(getLastOpenPhase("not-a-session-in-this-process")).toBeNull();
    expect(getLastBreadcrumb("not-a-session-in-this-process")).toBeNull();
  });
});
