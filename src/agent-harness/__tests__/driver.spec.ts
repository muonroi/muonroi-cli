import { describe, expect, it } from "vitest";
import { createDriver } from "../driver";
import type { LiveFrame } from "../protocol";

const frame: LiveFrame = {
  mode: "live",
  version: "0.1.0",
  seq: 1,
  ts: 0,
  focus: "composer",
  nodes: [
    {
      id: "root",
      role: "dialog",
      children: [
        { id: "composer", role: "textbox", value: "", focus: true },
        { id: "send", role: "button", name: "Send" },
        { id: "status", role: "statusbar", value: "Ready" },
      ],
    },
  ],
};

describe("driver", () => {
  it("snapshot returns the latest frame", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.snapshot()?.seq).toBe(1);
  });

  it("query throws on multi-match", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(() => d.query("role=listitem")).not.toThrow();
  });

  it("count works", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.count("role=button")).toBe(1);
  });

  it("queryAll returns all matches", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.queryAll("role=dialog").length).toBe(1);
  });

  it("expect evaluates predicate", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame });
    expect(d.expect("id=status", { field: "value", op: "eq", rhs: "Ready" })).toBe(true);
  });

  it("wait_for(idle) resolves on idle event", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ idle: true, timeoutMs: 100 });
    setTimeout(() => d._ingest({ kind: "idle" }), 10);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(selector) resolves when selector appears", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ selector: "role=dialog", timeoutMs: 100 });
    setTimeout(() => d._ingest({ kind: "frame", frame }), 10);
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for times out", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    await expect(d.wait_for({ selector: "role=nonexistent", timeoutMs: 30 })).rejects.toThrow(/timeout/i);
  });

  it("query throws when selector matches multiple nodes", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({
      kind: "frame",
      frame: {
        mode: "live",
        version: "0.1.0",
        seq: 1,
        ts: 0,
        nodes: [
          {
            id: "r",
            role: "dialog",
            children: [
              { id: "a", role: "listitem" },
              { id: "b", role: "listitem" },
            ],
          },
        ],
      },
    });
    expect(() => d.query("role=listitem")).toThrow(/ambiguous/);
  });
});
