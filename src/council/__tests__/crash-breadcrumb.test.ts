/**
 * Council crash breadcrumbs — the durable trail added after the 2026-09-09
 * `/ideal` crash left a 7m11s hole in `~/.muonroi-cli/debug.log` and no exit
 * record of any kind.
 *
 * What these pin:
 *   - a breadcrumb is a single JSONL line carrying ISO ts, ms-since-start,
 *     marker, pid and `process.memoryUsage()` (the memory series is the ONLY
 *     way this process can confirm or exclude an OOM after the fact);
 *   - the writer FAILS OPEN — a breadcrumb that cannot be written must never
 *     throw into the council path, and must still be reported (No Silent Catch);
 *   - the file is BOUNDED by a single rollover, so the trail cannot grow without
 *     limit across sessions;
 *   - the heartbeat only runs while a call is in flight, and stops on cleanup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/logger.js")>("../../utils/logger.js");
  return {
    ...actual,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { logger } from "../../utils/logger.js";
import {
  __resetBreadcrumbStateForTests,
  type BreadcrumbRecord,
  beginCouncilCall,
  breadcrumb,
  breadcrumbFilePath,
  getLastBreadcrumb,
  isBreadcrumbEnabled,
  isHeartbeatArmed,
  MAX_FILE_BYTES,
  setBreadcrumbSession,
} from "../crash-breadcrumb.js";

const mockLoggerError = logger.error as unknown as ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  mockLoggerError.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-breadcrumb-"));
  filePath = path.join(tmpDir, "council-breadcrumbs.jsonl");
  process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = filePath;
  delete process.env.MUONROI_COUNCIL_BREADCRUMBS;
  __resetBreadcrumbStateForTests();
});

afterEach(() => {
  __resetBreadcrumbStateForTests();
  delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
  delete process.env.MUONROI_COUNCIL_BREADCRUMBS;
  delete process.env.MUONROI_COUNCIL_BREADCRUMB_HEARTBEAT_MS;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly; the OS temp dir is disposable anyway.
  }
});

describe("breadcrumb()", () => {
  it("writes one JSONL line carrying timestamp, marker, pid and the memory sample", () => {
    breadcrumb("council.phase.enter", { phase: "synthesis", attempt: 1 });

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const rec = lines[0];
    expect(rec.marker).toBe("council.phase.enter");
    expect(rec.pid).toBe(process.pid);
    expect(new Date(rec.ts).toString()).not.toBe("Invalid Date");
    expect(typeof rec.tMs).toBe("number");
    expect(rec.tMs).toBeGreaterThanOrEqual(0);
    // G4: without the memory series an OOM abort is unfalsifiable from disk.
    expect(rec.mem.rss).toBeGreaterThan(0);
    expect(typeof rec.mem.heapUsed).toBe("number");
    expect(typeof rec.mem.heapTotal).toBe("number");
    expect(typeof rec.mem.external).toBe("number");
    // caller-supplied fields survive verbatim
    expect(rec.phase).toBe("synthesis");
    expect(rec.attempt).toBe(1);
  });

  // Same defect class as src/utils/logger.ts: a bare JSON.stringify would
  // collapse an Error placed in `extra` to "{}" (message/stack are
  // non-enumerable). No current caller does this, but the writer bypasses
  // the logger entirely, so it needs its own guard.
  it("serializes an Error placed in extra instead of collapsing it to '{}'", () => {
    breadcrumb("council.candidate.failed", { error: new Error("candidate boom") });
    const rec = readLines()[0] as unknown as { error: { message: string; stack?: string[] } };
    expect(rec.error.message).toBe("candidate boom");
    expect(Array.isArray(rec.error.stack)).toBe(true);
  });

  // Security follow-up (post-review): serializeError alone is UNREDACTED — a
  // secret embedded in an Error's message/stack/own-properties would persist
  // verbatim to the plaintext council-breadcrumbs.jsonl file on disk.
  // breadcrumb() must go through serializeErrorRedacted, not serializeError.
  describe("secret redaction", () => {
    it("redacts an sk- key, a bearer token, and an Authorization header embedded in message/stack", () => {
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const fakeToken = `eyJhbGciOiJIUzI1NiJ9${".fakepayload.fakesignature1234567890"}`;
      const err = new Error(`auth failed with key ${fakeKey} — Authorization: Bearer ${fakeToken}`);
      err.stack = `Error: auth failed with key ${fakeKey}\n    at doAuth (Authorization: Bearer ${fakeToken})`;

      breadcrumb("council.candidate.failed", { error: err });

      const raw = fs.readFileSync(filePath, "utf8");
      expect(raw).not.toContain(fakeKey);
      expect(raw).not.toContain(fakeToken);
      const rec = readLines()[0] as unknown as { error: { message: string; stack: string[] } };
      expect(rec.error.message).toContain("[REDACTED");
      expect(rec.error.stack.join("\n")).toContain("[REDACTED");
    });

    it("redacts an Error subclass's token/apiKey/password own properties", () => {
      class SdkError extends Error {
        apiKey: string;
        constructor(message: string, apiKey: string) {
          super(message);
          this.name = "SdkError";
          this.apiKey = apiKey;
        }
      }
      const fakeKey = `sk-proj${"ABCDEF1234567890abcdef1234567890"}`;
      const err = new SdkError("sdk call failed", fakeKey);

      breadcrumb("council.candidate.failed", { error: err });

      const raw = fs.readFileSync(filePath, "utf8");
      expect(raw).not.toContain(fakeKey);
      const rec = readLines()[0] as unknown as { error: { apiKey: string } };
      expect(rec.error.apiKey).toBe("[REDACTED]");
    });
  });

  it("stamps the session id once set", () => {
    setBreadcrumbSession("sess-abc123");
    breadcrumb("council.candidate.start");
    expect(readLines()[0].sessionId).toBe("sess-abc123");
  });

  it("appends rather than truncating, so the trail survives across calls", () => {
    breadcrumb("a");
    breadcrumb("b");
    breadcrumb("c");
    expect(readLines().map((r) => r.marker)).toEqual(["a", "b", "c"]);
  });

  it("exposes the most recent record for the process-exit handler", () => {
    breadcrumb("council.phase.enter", { phase: "clarify" });
    const last = getLastBreadcrumb();
    expect(last?.marker).toBe("council.phase.enter");
    expect(last?.phase).toBe("clarify");
  });

  it("is a no-op when the kill switch is set", () => {
    process.env.MUONROI_COUNCIL_BREADCRUMBS = "0";
    expect(isBreadcrumbEnabled()).toBe(false);
    breadcrumb("suppressed");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("is armed by DEFAULT — the whole point is that it is on when the crash recurs", () => {
    delete process.env.MUONROI_COUNCIL_BREADCRUMBS;
    expect(isBreadcrumbEnabled()).toBe(true);
  });
});

describe("fail-open", () => {
  it("does not throw when the file cannot be written, and reports why", () => {
    // Point the writer at a path whose PARENT is a regular file: mkdirSync and
    // appendFileSync both fail with ENOTDIR/EEXIST.
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = path.join(blocker, "nested", "bc.jsonl");
    __resetBreadcrumbStateForTests();

    expect(() => breadcrumb("should-not-throw")).not.toThrow();

    // No Silent Catch: module + operation + message.
    expect(mockLoggerError).toHaveBeenCalled();
    const [ns, msg, ctx] = mockLoggerError.mock.calls[0];
    expect(ns).toBe("orchestrator");
    expect(String(msg)).toContain("[crash-breadcrumb]");
    expect(String((ctx as { message?: string })?.message ?? "")).not.toBe("");
  });

  it("self-disables after repeated write failures instead of thrashing", () => {
    const blocker = path.join(tmpDir, "blocker2");
    fs.writeFileSync(blocker, "not a directory");
    process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = path.join(blocker, "nested", "bc.jsonl");
    __resetBreadcrumbStateForTests();

    for (let i = 0; i < 5; i++) breadcrumb(`attempt-${i}`);

    expect(isBreadcrumbEnabled()).toBe(false);
    const disableMsg = mockLoggerError.mock.calls.map((c) => String(c[1])).find((m) => m.includes("disabled"));
    expect(disableMsg).toBeDefined();
  });
});

describe("bounding", () => {
  it("rolls over to a single .1 file once the active file exceeds the cap", () => {
    // Seed the active file just under the cap so one more line trips rotation.
    fs.writeFileSync(filePath, "x".repeat(MAX_FILE_BYTES));
    __resetBreadcrumbStateForTests();

    breadcrumb("after-rotation");

    const rotated = path.join(tmpDir, "council-breadcrumbs.1.jsonl");
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.statSync(rotated).size).toBe(MAX_FILE_BYTES);
    // The active file restarts with just the new line — bounded at ~2x the cap.
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].marker).toBe("after-rotation");
  });
});

describe("heartbeat", () => {
  it("does not arm when no council call is in flight", () => {
    breadcrumb("idle");
    expect(isHeartbeatArmed()).toBe(false);
  });

  it("emits periodic samples while a call is in flight and stops on cleanup", async () => {
    process.env.MUONROI_COUNCIL_BREADCRUMB_HEARTBEAT_MS = "250";
    const stop = beginCouncilCall("council.synthesis", { modelId: "fixture-model-a" });
    expect(isHeartbeatArmed()).toBe(true);

    await new Promise((r) => setTimeout(r, 620));
    stop();
    expect(isHeartbeatArmed()).toBe(false);

    const beats = readLines().filter((r) => r.marker === "council.heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    const inFlight = beats[0].inFlight as Array<{ marker: string; elapsedMs: number; modelId?: string }>;
    expect(beats[0].inFlightCount).toBe(1);
    expect(inFlight[0].marker).toBe("council.synthesis");
    expect(inFlight[0].modelId).toBe("fixture-model-a");
    expect(inFlight[0].elapsedMs).toBeGreaterThan(0);
    // G4 again: every beat carries memory, so a rising series is visible even
    // when nothing else gets logged.
    expect(beats[0].mem.rss).toBeGreaterThan(0);

    const countAfterStop = readLines().length;
    await new Promise((r) => setTimeout(r, 400));
    expect(readLines().length).toBe(countAfterStop);
  });

  it("collapses concurrent in-flight calls into one line per tick", async () => {
    process.env.MUONROI_COUNCIL_BREADCRUMB_HEARTBEAT_MS = "250";
    const stopA = beginCouncilCall("council.opening", { modelId: "fixture-model-a" });
    const stopB = beginCouncilCall("council.opening", { modelId: "fixture-model-b" });

    await new Promise((r) => setTimeout(r, 350));
    stopA();
    stopB();

    const beats = readLines().filter((r) => r.marker === "council.heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0].inFlightCount).toBe(2);
    expect((beats[0].inFlight as unknown[]).length).toBe(2);
  });

  it("returns an inert stop thunk when disabled, so callers need no branch", () => {
    process.env.MUONROI_COUNCIL_BREADCRUMBS = "0";
    const stop = beginCouncilCall("council.clarify");
    expect(isHeartbeatArmed()).toBe(false);
    expect(() => stop()).not.toThrow();
  });
});

describe("breadcrumbFilePath()", () => {
  it("defaults under ~/.muonroi-cli when no override is set", () => {
    delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    expect(breadcrumbFilePath()).toBe(path.join(os.homedir(), ".muonroi-cli", "council-breadcrumbs.jsonl"));
  });
});
