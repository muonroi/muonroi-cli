/**
 * wrapper-happy-path.spec.ts
 *
 * Asserts the CONFORMING protocol contract: a well-formed LiveFrame, LiveEvent,
 * or idle message fed through driver._ingest() MUST be accessible via the
 * driver's public API (snapshot, query, last_event, wait_for, events).
 *
 * This is the POSITIVE contract test the council identified as missing:
 * every spec in tests/harness/ assumes the protocol holds, but none verify
 * that a conforming envelope actually makes it through.
 *
 * Unlike E2E specs (which spawn a full TUI), these are integration-level
 * tests: they import createDriver directly from the core package and feed it
 * the same pre-parsed Ingested shapes that the transport layer (helpers.ts,
 * mcp-server.ts) produces from JSON lines.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/wrapper-happy-path.spec.ts
 */

import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseFrame: LiveFrame = {
  mode: "live",
  version: "0.4.0",
  seq: 1,
  ts: 1000,
  focus: "composer",
  nodes: [
    {
      id: "composer",
      role: "textbox",
      value: "hello",
      focus: true,
    },
    {
      id: "send-btn",
      role: "button",
      name: "Send",
    },
    {
      id: "msg-list",
      role: "listbox",
      children: [
        { id: "msg-0", role: "listitem", value: "Hello from user" },
        { id: "msg-1", role: "listitem", value: "Response from model" },
      ],
    },
  ],
};

const toastEvent: LiveEvent = {
  t: "event",
  kind: "toast",
  level: "warn",
  text: "API error — retrying",
  ttlMs: 5000,
};

const streamEvent: LiveEvent = {
  t: "event",
  kind: "stream.delta",
  target: "msg-2",
  text: "hello",
};

const councilEvent: LiveEvent = {
  t: "event",
  kind: "council-step",
  phaseId: "p1",
  phaseKind: "architect",
  state: "done",
  label: "Architect opening statement",
  elapsedMs: 3400,
};

// ---------------------------------------------------------------------------
// Driver happy-path — protocol contract positive assertions
// ---------------------------------------------------------------------------

describe("wrapper happy-path: driver protocol contract", () => {
  it("ingests a conforming LiveFrame and returns it via snapshot", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    const snap = d.snapshot();
    expect(snap).not.toBeNull();
    expect(snap?.seq).toBe(1);
    expect(snap?.focus).toBe("composer");
    expect(snap?.nodes.length).toBe(3);
  });

  it("updates snapshot on subsequent frames", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    d._ingest({
      kind: "frame",
      frame: { ...baseFrame, seq: 2, nodes: [{ id: "c", role: "textbox" }] },
    });
    expect(d.snapshot()?.seq).toBe(2);
    expect(d.snapshot()?.nodes.length).toBe(1);
  });

  it("query returns a single node by selector", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    const node = d.query("id=send-btn");
    expect(node).not.toBeNull();
    expect(node?.role).toBe("button");
    expect(node?.name).toBe("Send");
  });

  it("query returns null for unmatched selector", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    expect(d.query("id=nonexistent")).toBeNull();
  });

  it("queryAll returns all matching nodes", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    const items = d.queryAll("role=listitem");
    expect(items.length).toBe(2);
    expect(items[0]?.id).toBe("msg-0");
    expect(items[1]?.id).toBe("msg-1");
  });

  it("count returns the correct number", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    expect(d.count("role=dialog")).toBe(0); // synthetic root excluded
    expect(d.count("role=listitem")).toBe(2);
  });

  it("expect evaluates predicates correctly", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    expect(d.expect("id=composer", { field: "value", op: "eq", rhs: "hello" })).toBe(true);
    expect(d.expect("id=composer", { flag: "focus", value: true })).toBe(true);
    expect(d.expect("id=nonexistent", { field: "id", op: "eq", rhs: "x" })).toBe(false);
  });

  it("last_event returns the most recent event of a given kind", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "event", event: toastEvent });
    const e = d.last_event("toast") as { level: string; text: string } | null;
    expect(e).not.toBeNull();
    expect(e?.level).toBe("warn");
    expect(e?.text).toBe("API error — retrying");
  });

  it("last_event returns null when no event of that kind was ingested", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    expect(d.last_event("toast")).toBeNull();
  });

  it("last_event with multiple events returns the latest matching", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "event", event: { t: "event", kind: "toast", level: "info", text: "first" } });
    d._ingest({ kind: "event", event: { t: "event", kind: "toast", level: "error", text: "second" } });
    const e = d.last_event("toast") as { level: string; text: string } | null;
    expect(e?.level).toBe("error");
    expect(e?.text).toBe("second");
  });

  it("wait_for(idle) resolves on idle ingest", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ idle: true, timeoutMs: 50 });
    d._ingest({ kind: "idle" });
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(selector) resolves when selector appears in a frame", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ selector: "id=new-node", timeoutMs: 50 });
    d._ingest({
      kind: "frame",
      frame: { mode: "live", version: "0.4.0", seq: 2, ts: 2000, nodes: [{ id: "new-node", role: "button" }] },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(event) resolves when matching event arrives", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({ event: "route-decision", timeoutMs: 50 });
    d._ingest({
      kind: "event",
      event: {
        t: "event",
        kind: "route-decision",
        path: "hot-path",
        complexity: "simple",
        forceCouncil: false,
        runId: "r1",
      },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(event) with custom match function", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({
      event: "council-step",
      match: (e) => e.kind === "council-step" && e.phaseKind === "synthesis" && e.state === "done",
      timeoutMs: 50,
    });
    // First event — should not match (wrong kind)
    d._ingest({ kind: "event", event: { t: "event", kind: "toast", level: "info", text: "nope" } });
    // Second event — should not match (wrong phaseKind)
    d._ingest({ kind: "event", event: { ...councilEvent, phaseKind: "architect" } });
    // Third event — matches
    d._ingest({
      kind: "event",
      event: { ...councilEvent, phaseKind: "synthesis" },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("wait_for(all) resolves when all conditions are met", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const p = d.wait_for({
      all: [{ selector: "id=done-btn" }, { idle: true }],
      timeoutMs: 100,
    });
    d._ingest({ kind: "idle" });
    d._ingest({
      kind: "frame",
      frame: { mode: "live", version: "0.4.0", seq: 3, ts: 3000, nodes: [{ id: "done-btn", role: "button" }] },
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("events() subscriber receives ingested events", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const all: LiveEvent[] = [];
    const itr = d.events();
    (async () => {
      for await (const e of itr) {
        all.push(e);
        if (all.length >= 3) break;
      }
    })();
    d._ingest({ kind: "event", event: toastEvent });
    d._ingest({ kind: "event", event: streamEvent });
    d._ingest({ kind: "event", event: councilEvent });
    await new Promise((r) => setTimeout(r, 10));
    expect(all.length).toBe(3);
  });

  it("events() with kind filter only delivers matching events", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    const toasts: LiveEvent[] = [];
    const itr = d.events({ kinds: ["toast"] });
    (async () => {
      for await (const e of itr) {
        toasts.push(e);
        if (toasts.length >= 2) break;
      }
    })();
    d._ingest({ kind: "event", event: streamEvent }); // filtered out
    d._ingest({ kind: "event", event: toastEvent });
    d._ingest({ kind: "event", event: { t: "event", kind: "toast", level: "error", text: "boom" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts.length).toBe(2);
    expect(toasts.every((e) => e.kind === "toast")).toBe(true);
  });

  it("events() late-subscribe replays buffered events", async () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "event", event: toastEvent });
    d._ingest({ kind: "event", event: streamEvent });
    // Late subscribe: should immediately get the buffered events
    const all: LiveEvent[] = [];
    const itr = d.events();
    (async () => {
      for await (const e of itr) {
        all.push(e);
        if (all.length >= 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(all.length).toBe(2);
  });

  it("changes_since returns current frame when seq > given", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    expect(d.changes_since(0)).not.toBeNull();
    expect(d.changes_since(1)).toBeNull(); // same seq → no change
    expect(d.changes_since(2)).toBeNull(); // higher seq → no change
  });

  it("sendKey and sendType are called correctly", () => {
    const keys: string[] = [];
    const texts: string[] = [];
    const d = createDriver({
      sendKey: (k) => keys.push(k),
      sendType: (t) => texts.push(t),
    });
    d.press("Enter");
    d.press("Escape");
    d.type("hello world");
    d.press_sequence(["Down", "Down", "Enter"]);
    expect(keys).toEqual(["Enter", "Escape", "Down", "Down", "Enter"]);
    expect(texts).toEqual(["hello world"]);
  });

  it("focus dispatches __focus__:<id>", () => {
    const keys: string[] = [];
    const d = createDriver({ sendKey: (k) => keys.push(k), sendType: () => {} });
    d._ingest({ kind: "frame", frame: baseFrame });
    d.focus("role=button");
    expect(keys).toEqual(["__focus__:send-btn"]);
  });

  it("render_text returns ASCII tree without crashing", () => {
    const d = createDriver({ sendKey: () => {}, sendType: () => {} });
    expect(d.render_text()).toBe("(no frame)");
    d._ingest({ kind: "frame", frame: baseFrame });
    const text = d.render_text();
    expect(text).toContain("textbox");
    expect(text).toContain("composer");
    expect(text).toContain("listitem");
  });
});
