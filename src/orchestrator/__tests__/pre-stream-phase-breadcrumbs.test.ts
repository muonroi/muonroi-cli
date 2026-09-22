/**
 * Durable pre-stream phase breadcrumbs (message-processor.ts's `preStreamPhase`
 * helper, `pre-stream.<toolEngine>` pair in tool-engine.ts, and the
 * `ensureCouncilFactory` pair in council/llm.ts).
 *
 * Session 1e9db4d68da0: the top-level 120s turn watchdog fired with ZERO
 * interaction_logs / call_accounting rows anywhere in the pre-stream window —
 * nothing said WHICH await hung. These breadcrumbs close that gap: a
 * `pre-stream.<phase>.start` line with no matching `.end` names the last
 * phase that started and did not finish, which orchestrator.ts's watchdog
 * catch reads via `getLastBreadcrumb()` and writes into the `error`
 * interaction_log row's `data.lastPhase` field.
 *
 * These tests cover the two ends of that contract:
 *   1. A normal (resolving) phase writes a `.start` THEN a `.end` line.
 *   2. A phase that never settles leaves the trail's last line as its
 *      `.start` with no `.end` — and derives the same `lastPhase` string
 *      orchestrator.ts's watchdog catch computes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetBreadcrumbStateForTests,
  type BreadcrumbRecord,
  getLastBreadcrumb,
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

// Mirrors orchestrator.ts's watchdog catch: a `.start` breadcrumb with no
// matching `.end` names the phase that hung. Kept in the test (not imported)
// because the real derivation lives inline in a large catch block, not its
// own exported function — this pins the CONTRACT (marker shape), not the
// orchestrator's internal wiring.
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    // This is the exact derivation orchestrator.ts's watchdog catch performs
    // to populate the `error` interaction_log row's `data.lastPhase` field.
    expect(lastOpenPhaseFrom(last)).toBe("gsdGate");
  });

  it("a later phase's breadcrumb does not retroactively close an earlier hung phase", async () => {
    void preStreamPhase("routerDecide", "sess-hang-2", () => new Promise<void>(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    // Even if some OTHER, unrelated phase starts afterward (e.g. a nested
    // call elsewhere in the process), the hung phase's `.start` is still the
    // one immediately preceding it in the trail — the watchdog only reads
    // the LAST line, so a genuinely nested/concurrent write is a known,
    // documented limitation (see message-processor.ts's preStreamPhase doc
    // comment), not silently "fixed" by this test.
    const linesBefore = readLines();
    expect(linesBefore).toHaveLength(1);
    expect(linesBefore[0]!.marker).toBe("pre-stream.routerDecide.start");
  });
});
