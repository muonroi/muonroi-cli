/**
 * event-tee.spec.ts — Unit tests for the optional JSONL event sink.
 *
 * Verifies:
 * - Disabled path: unset/blank env → factory returns null (zero behavior).
 * - Enabled path: appends one JSONL line per event with ts+kind+event.
 * - Ephemeral kinds carry an at-emit visualText; persistent kinds do NOT.
 * - Visual-render failure still writes the event record (No-Silent-Catch).
 * - A missing kind (defensive) is dropped, not crashed on.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventTee, EPHEMERAL_KINDS } from "../src/event-tee.js";
import { makeLineHandler } from "../src/mcp-server.js";
import type { LiveEvent } from "../src/protocol.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "event-tee-"));
  logPath = join(dir, "events.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const toast: LiveEvent = { t: "event", kind: "toast", level: "error", text: "boom" } as LiveEvent;
const askcard: LiveEvent = { t: "event", kind: "askcard-open" } as unknown as LiveEvent;

describe("createEventTee — disabled path", () => {
  it("returns null when env is undefined", () => {
    expect(createEventTee(() => "x", undefined)).toBeNull();
  });
  it("returns null when env is blank/whitespace", () => {
    expect(createEventTee(() => "x", "   ")).toBeNull();
  });
});

describe("createEventTee — enabled path", () => {
  it("appends one JSONL line per event with ts+kind+event", () => {
    const tee = createEventTee(() => null, logPath);
    expect(tee).not.toBeNull();
    tee?.(askcard);
    tee?.(askcard);
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("askcard-open");
    expect(typeof lines[0].ts).toBe("number");
    expect((lines[0].event as { kind: string }).kind).toBe("askcard-open");
  });

  it("attaches visualText for ephemeral kinds only", () => {
    const tee = createEventTee(() => "SCREEN", logPath);
    tee?.(toast); // ephemeral → visual captured
    tee?.(askcard); // persistent → no visual
    const lines = readLines();
    expect(lines[0].kind).toBe("toast");
    expect(lines[0].visualText).toBe("SCREEN");
    expect(lines[1].kind).toBe("askcard-open");
    expect(lines[1].visualText).toBeUndefined();
  });

  it("does not call the visual renderer for persistent kinds", () => {
    const getVisual = vi.fn(() => "SCREEN");
    const tee = createEventTee(getVisual, logPath);
    tee?.(askcard);
    expect(getVisual).not.toHaveBeenCalled();
  });

  it("still writes the event record when visual render throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tee = createEventTee(() => {
      throw new Error("render failed");
    }, logPath);
    tee?.(toast);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("toast");
    expect(lines[0].visualText).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[event-tee] visual snapshot failed"));
    spy.mockRestore();
  });

  it("drops a malformed event with no kind without throwing", () => {
    const tee = createEventTee(() => "x", logPath);
    expect(() => tee?.({ t: "event" } as unknown as LiveEvent)).not.toThrow();
    expect(() => readFileSync(logPath, "utf8")).toThrow(); // nothing written
  });
});

describe("makeLineHandler — sidechannel wiring", () => {
  it("routes an event line to the tee (with visual for ephemeral) and ingests it", () => {
    const ingested: unknown[] = [];
    const driver = { _ingest: (m: unknown) => ingested.push(m) };
    const tee = createEventTee(() => "FRAME", logPath);
    const handle = makeLineHandler(driver, tee);

    handle(JSON.stringify({ t: "event", kind: "toast", level: "error", text: "boom" }));
    handle(JSON.stringify({ mode: "live", nodes: [] })); // frame → ingested, NOT teed

    // Both went to the driver; only the event went to the JSONL sink.
    expect(ingested).toHaveLength(2);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("toast");
    expect(lines[0].visualText).toBe("FRAME");
  });

  it("tolerates a null tee and malformed lines", () => {
    const driver = { _ingest: vi.fn() };
    const handle = makeLineHandler(driver, null);
    expect(() => handle("{not json")).not.toThrow();
    expect(() => handle(JSON.stringify({ t: "event", kind: "toast" }))).not.toThrow();
    expect(driver._ingest).toHaveBeenCalledTimes(1); // only the valid event line
  });
});

describe("EPHEMERAL_KINDS", () => {
  it("covers the flash/transient kinds and excludes persistent modals", () => {
    expect(EPHEMERAL_KINDS.has("toast")).toBe(true);
    expect(EPHEMERAL_KINDS.has("ee-error")).toBe(true);
    expect(EPHEMERAL_KINDS.has("disconnect")).toBe(true);
    expect(EPHEMERAL_KINDS.has("askcard-open")).toBe(false);
    expect(EPHEMERAL_KINDS.has("council-step")).toBe(false);
  });
});
