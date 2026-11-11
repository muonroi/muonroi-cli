import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { councilLiveness, readCouncilLiveness } from "../bench/council-liveness";

const NOW = Date.parse("2026-11-11T10:24:05.000Z");
const PID = 48736;
const SID = "26516fe0c62e";

function beat(over: Record<string, unknown> = {}, agoMs = 3_000): string {
  return JSON.stringify({
    ts: new Date(NOW - agoMs).toISOString(),
    marker: "council.heartbeat",
    pid: PID,
    sessionId: SID,
    inFlightCount: 1,
    inFlight: [{ marker: "council.research", elapsedMs: 300320 }],
    ...over,
  });
}

const run = { pid: PID, sessionIds: new Set([SID]) };

describe("councilLiveness (bench settle rule)", () => {
  it("recent heartbeat with inFlight>0 is alive", () => {
    const r = councilLiveness([beat()], run, NOW);
    expect(r.alive).toBe(true);
    expect(r.markers).toEqual(["council.research"]);
  });

  it("stale heartbeat falls back to the normal settle rule", () => {
    expect(councilLiveness([beat({}, 60_000)], run, NOW).alive).toBe(false);
  });

  it("inFlightCount 0 is not alive even when fresh", () => {
    expect(councilLiveness([beat({ inFlightCount: 0, inFlight: [] })], run, NOW).alive).toBe(false);
  });

  it("ignores a different pid AND a different session", () => {
    expect(councilLiveness([beat({ pid: 1, sessionId: "other" })], run, NOW).alive).toBe(false);
  });

  it("matches on sessionId alone when the pid differs (wrapper pid)", () => {
    expect(councilLiveness([beat({ pid: 1 })], run, NOW).alive).toBe(true);
  });

  it("matches on pid alone when the session is not yet known", () => {
    expect(councilLiveness([beat({ sessionId: undefined })], { pid: PID, sessionIds: new Set() }, NOW).alive).toBe(
      true,
    );
  });

  it("the newest heartbeat decides, regardless of line order", () => {
    const older = beat({}, 10_000);
    const newerIdle = beat({ inFlightCount: 0, inFlight: [] }, 2_000);
    expect(councilLiveness([newerIdle, older], run, NOW).alive).toBe(false);
    expect(councilLiveness([older, newerIdle], run, NOW).alive).toBe(false);
  });

  it("another run's fresh heartbeat does not mask this run's stale one", () => {
    const mine = beat({}, 60_000);
    const theirs = beat({ pid: 1, sessionId: "other" }, 1_000);
    expect(councilLiveness([mine, theirs], run, NOW).alive).toBe(false);
  });

  it("non-heartbeat markers are ignored", () => {
    const phase = JSON.stringify({ ts: new Date(NOW).toISOString(), marker: "council.phase.enter", pid: PID });
    expect(councilLiveness([phase], run, NOW).alive).toBe(false);
  });

  it("reports a malformed heartbeat line and keeps going", () => {
    const errors: string[] = [];
    const r = councilLiveness(["{council.heartbeat not json", beat()], run, NOW, {
      onParseError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
    });
    expect(errors).toHaveLength(1);
    expect(r.alive).toBe(true);
  });
});

describe("readCouncilLiveness (file IO)", () => {
  let dir: string | undefined;
  const savedOverride = process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
  beforeEach(() => {
    delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
  });
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    else process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = savedOverride;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("missing file: not alive, debug only, no warning", () => {
    dir = mkdtempSync(join(tmpdir(), "council-liveness-"));
    const debug: string[] = [];
    const warn: string[] = [];
    const r = readCouncilLiveness(dir, run, { debug: (m) => debug.push(m), warn: (m) => warn.push(m) }, NOW);
    expect(r.alive).toBe(false);
    expect(debug).toHaveLength(1);
    expect(warn).toHaveLength(0);
  });

  it("reads the run's heartbeat from <home>/council-breadcrumbs.jsonl", () => {
    dir = mkdtempSync(join(tmpdir(), "council-liveness-"));
    writeFileSync(join(dir, "council-breadcrumbs.jsonl"), `${beat({ pid: 1, sessionId: "x" })}\n${beat()}\n`);
    const r = readCouncilLiveness(dir, run, { debug: () => {}, warn: () => {} }, NOW);
    expect(r.alive).toBe(true);
  });
});
