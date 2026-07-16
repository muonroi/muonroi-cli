import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventTee, resolveEventLogPath } from "../src/event-tee.js";

/**
 * The sink used to be opt-in, and nobody opted in — so a 17-minute /ideal pause
 * on an askcard was indistinguishable from a hang: askcard-open writes no DB
 * row, and the only file that would have recorded it was never created. It is
 * now on by default; these tests pin that default and its escape hatch.
 */
describe("resolveEventLogPath", () => {
  it("defaults to a per-pid file in tmpdir when unset", () => {
    expect(resolveEventLogPath(undefined, 4242)).toBe(join(tmpdir(), "muonroi-harness-events-4242.jsonl"));
  });

  it("defaults when blank or whitespace", () => {
    expect(resolveEventLogPath("   ", 7)).toBe(join(tmpdir(), "muonroi-harness-events-7.jsonl"));
  });

  it("is per-pid so concurrent harness servers cannot interleave", () => {
    expect(resolveEventLogPath(undefined, 1)).not.toBe(resolveEventLogPath(undefined, 2));
  });

  it.each(["0", "off", "false", "no", "OFF", "False"])("disables on %s", (v) => {
    expect(resolveEventLogPath(v, 1)).toBeNull();
  });

  it("honours an explicit path verbatim", () => {
    expect(resolveEventLogPath("/tmp/mine.jsonl", 1)).toBe("/tmp/mine.jsonl");
  });
});

describe("createEventTee default-on", () => {
  it("returns a sink when the env is unset — the default that was missing", () => {
    expect(createEventTee(() => null, undefined)).not.toBeNull();
  });

  it("returns null only when explicitly disabled", () => {
    expect(createEventTee(() => null, "0")).toBeNull();
  });
});
