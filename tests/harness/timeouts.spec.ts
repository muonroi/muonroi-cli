/**
 * timeouts.spec.ts
 *
 * Driver-level timeout tests — does NOT spawn the TUI process.
 * Uses createDriver directly with stub sendKey/sendType, mirroring the
 * pattern from src/agent-harness/__tests__/driver.spec.ts.
 *
 * Organizational note: placed in tests/harness/ alongside the E2E specs for
 * consistency even though these are pure unit tests of the driver.
 */

import { describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveFrame } from "../../src/agent-harness/protocol";

const minimalFrame: LiveFrame = {
  mode: "live",
  version: "0.1.0",
  seq: 1,
  ts: 0,
  nodes: [
    {
      id: "root",
      role: "dialog",
      children: [{ id: "composer", role: "textbox", value: "", focus: true }],
    },
  ],
};

describe("driver timeout behaviour", () => {
  it("wait_for({ selector: 'never-appears' }) rejects with /timeout/i after timeoutMs elapses", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    await expect(d.wait_for({ selector: "role=nonexistent", timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  });

  it("wait_for({ idle }) rejects with /timeout/i when no idle event arrives", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    await expect(d.wait_for({ idle: true, timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  });

  it("wait_for({ selector }) resolves before timeout when the matching frame arrives", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ selector: "role=textbox", timeoutMs: 200 });
    // Deliver the frame shortly after the waiter is registered
    setTimeout(() => d._ingest({ kind: "frame", frame: minimalFrame }), 20);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for({ idle }) resolves before timeout when an idle event arrives", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ idle: true, timeoutMs: 200 });
    setTimeout(() => d._ingest({ kind: "idle" }), 20);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for timeout error message includes the timeoutMs value", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const timeoutMs = 40;
    await expect(d.wait_for({ selector: "role=missing", timeoutMs })).rejects.toThrow(new RegExp(`${timeoutMs}ms`));
  });

  it("wait_for({ all: [...] }) rejects with /timeout/i when only some conditions are met", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    // Deliver a frame (satisfies selector condition) but never deliver idle
    d._ingest({ kind: "frame", frame: minimalFrame });
    await expect(d.wait_for({ all: [{ selector: "role=textbox" }, { idle: true }], timeoutMs: 50 })).rejects.toThrow(
      /timeout/i,
    );
  });

  it("wait_for({ all: [...] }) resolves when all conditions are satisfied", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ all: [{ selector: "role=textbox" }, { idle: true }], timeoutMs: 300 });
    setTimeout(() => {
      d._ingest({ kind: "frame", frame: minimalFrame });
      d._ingest({ kind: "idle" });
    }, 20);
    await expect(p).resolves.toBeUndefined();
  });

  it("multiple concurrent wait_for calls each resolve independently", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p1 = d.wait_for({ selector: "role=textbox", timeoutMs: 200 });
    const p2 = d.wait_for({ idle: true, timeoutMs: 200 });
    setTimeout(() => {
      d._ingest({ kind: "frame", frame: minimalFrame });
      d._ingest({ kind: "idle" });
    }, 20);
    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);
  });
});
