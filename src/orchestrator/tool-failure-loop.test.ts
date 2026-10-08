/**
 * N3 — "forward progress" must mean usefulness, not emission.
 *
 * `createStallWatchdog`'s progress timer is re-armed by a text-delta OR a
 * tool-call, so a sub-agent emitting a failing tool call every ~6s kept it
 * alive for 19 minutes (176 steps / 1116s / ~7.45M input tokens, max
 * inter-step gap 30.5s — no time threshold separates that from a healthy run
 * whose max gap is 30.2s). The discriminator is the RESULT.
 *
 * N = 8 is defended by the local interaction DB (~/.muonroi-cli/muonroi.db,
 * tool_calls join tool_results, 647 calls / 14 sessions): longest run of
 * consecutive same-class tool failures was 1 in 12 sessions and 2 in one
 * session; a single degenerate session had runs of 12 and 8, all `read_file`
 * returning the same error with DIFFERENT arguments — which is exactly why
 * `tool-repetition-detector.ts` (keyed on toolName + hash(input)) never fired.
 */

import { describe, expect, it } from "vitest";
import {
  buildToolFailureLoopMessage,
  createToolFailureLoopDetector,
  getToolFailureLoopThreshold,
  normalizeToolErrorClass,
  toolFailureClass,
} from "./stall-watchdog.js";

/** The literal error text observed 12x then 8x in session e28336959a62. */
const OBSERVED_ERR = 'ERROR: Failed to read file: The "path" property must be of type string, got undefined';

describe("normalizeToolErrorClass", () => {
  it("collapses the same failure carrying different paths into one class", () => {
    const a = normalizeToolErrorClass("ERROR: File not found: D:\\sources\\Core\\a.ts");
    const b = normalizeToolErrorClass("ERROR: File not found: /home/x/y/b.ts");
    expect(a).toBe(b);
    expect(a).toContain("file not found");
  });

  it("keeps genuinely different failures apart", () => {
    expect(normalizeToolErrorClass("ERROR: File not found: /a/b.ts")).not.toBe(
      normalizeToolErrorClass("ERROR: Permission denied: /a/b.ts"),
    );
  });

  it("erases digits so an exit code or line number does not split a class", () => {
    expect(normalizeToolErrorClass("ERROR: command failed with exit 1")).toBe(
      normalizeToolErrorClass("ERROR: command failed with exit 2"),
    );
  });
});

describe("toolFailureClass", () => {
  it("returns null for a successful tool result (a reset)", () => {
    expect(toolFailureClass("read_file", "[a.ts: lines 1-10 of 10]\n1 | hi")).toBeNull();
  });

  it("does not misread a successful grep whose OUTPUT mentions an error", () => {
    // The marker is a LEADING `ERROR:` (registry.ts formatResult), not the
    // substring "error" — otherwise `grep "ERROR"` would class itself a failure.
    expect(toolFailureClass("grep", "src/a.ts:12: throw new Error('ERROR: boom')")).toBeNull();
  });

  it("classes the repo's own ERROR: marker as a failure", () => {
    expect(toolFailureClass("read_file", OBSERVED_ERR)).toContain("read_file|");
  });

  it("classes an AI-SDK tool-error part as a failure even without the marker", () => {
    expect(toolFailureClass("bash", new Error("spawn ENOENT"), true)).toContain("bash|");
  });

  it("scopes the class by tool name so two tools failing alike do not accumulate", () => {
    expect(toolFailureClass("read_file", OBSERVED_ERR)).not.toBe(toolFailureClass("grep", OBSERVED_ERR));
  });
});

describe("createToolFailureLoopDetector", () => {
  it("trips at exactly N identical failures (the degenerate run's shape)", () => {
    const d = createToolFailureLoopDetector(8);
    const outcomes = Array.from({ length: 8 }, (_, i) =>
      // Args differ every call — the reason the existing repetition detector missed it.
      d.record("read_file", `${OBSERVED_ERR} (call ${i})`),
    );
    expect(outcomes.slice(0, 7).map((o) => o.tripped)).toEqual([false, false, false, false, false, false, false]);
    expect(outcomes[7]?.tripped).toBe(true);
    expect(outcomes[7]?.runLength).toBe(8);
  });

  it("trips only ONCE per run (no repeated abort on continued failures)", () => {
    const d = createToolFailureLoopDetector(3);
    d.record("read_file", OBSERVED_ERR);
    d.record("read_file", OBSERVED_ERR);
    expect(d.record("read_file", OBSERVED_ERR).tripped).toBe(true);
    expect(d.record("read_file", OBSERVED_ERR).tripped).toBe(false);
  });

  it("does NOT trip on 2 identical errors — the measured healthy maximum", () => {
    const d = createToolFailureLoopDetector(8);
    expect(d.record("read_file", OBSERVED_ERR).tripped).toBe(false);
    expect(d.record("read_file", OBSERVED_ERR).tripped).toBe(false);
    expect(d.runLength()).toBe(2);
  });

  it("does NOT trip on N DIFFERENT errors", () => {
    const d = createToolFailureLoopDetector(8);
    for (let i = 0; i < 12; i++) {
      const r = d.record("bash", `ERROR: distinct failure kind ${String.fromCharCode(97 + i)}`);
      expect(r.tripped).toBe(false);
      expect(r.runLength).toBe(1);
    }
  });

  it("does NOT trip on a slow-but-healthy sequence: one success resets the run", () => {
    const d = createToolFailureLoopDetector(4);
    // A legitimate iterate-to-green loop: read (ok) -> edit (ok) -> build (fails).
    for (let round = 0; round < 20; round++) {
      expect(d.record("read_file", "[a.ts: lines 1-3 of 3]").tripped).toBe(false);
      expect(d.record("edit_file", "Updated a.ts (+2 -1)").tripped).toBe(false);
      expect(d.record("bash", "ERROR: build failed: CS0103").tripped).toBe(false);
    }
    expect(d.runLength()).toBe(1);
  });

  it("resets when a different failure class interrupts the run", () => {
    const d = createToolFailureLoopDetector(4);
    d.record("read_file", OBSERVED_ERR);
    d.record("read_file", OBSERVED_ERR);
    d.record("read_file", OBSERVED_ERR);
    expect(d.record("read_file", "ERROR: Permission denied").runLength).toBe(1);
    expect(d.record("read_file", "ERROR: Permission denied").tripped).toBe(false);
  });

  it("is disabled when the threshold is below 2 (opt-out is total)", () => {
    const d = createToolFailureLoopDetector(0);
    for (let i = 0; i < 50; i++) expect(d.record("read_file", OBSERVED_ERR).tripped).toBe(false);
  });
});

describe("getToolFailureLoopThreshold", () => {
  const KEY = "MUONROI_TOOL_FAILURE_LOOP_N";
  const withEnv = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  };

  it("defaults to 8 — 4x the measured healthy maximum of 2", () => {
    expect(withEnv(undefined, getToolFailureLoopThreshold)).toBe(8);
  });

  it("honours a valid override", () => {
    expect(withEnv("12", getToolFailureLoopThreshold)).toBe(12);
  });

  it("treats a sub-2 value as an explicit opt-out rather than a hair trigger", () => {
    expect(withEnv("0", getToolFailureLoopThreshold)).toBe(0);
    expect(withEnv("1", getToolFailureLoopThreshold)).toBe(0);
  });

  it("ignores garbage and falls back to the default", () => {
    expect(withEnv("not-a-number", getToolFailureLoopThreshold)).toBe(8);
  });
});

describe("buildToolFailureLoopMessage", () => {
  it("names the tool, the run length and the last failure", () => {
    const msg = buildToolFailureLoopMessage("read_file", 8, OBSERVED_ERR);
    expect(msg).toContain("tool-failure-loop abort");
    expect(msg).toContain("read_file");
    expect(msg).toContain("8 times in a row");
    expect(msg).toContain("must be of type string");
  });
});
