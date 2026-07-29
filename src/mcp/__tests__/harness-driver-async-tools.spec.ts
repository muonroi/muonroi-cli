import type { Driver } from "@muonroi/agent-harness-core/driver";
import { type AsyncToolDeps, registerAsyncTools } from "@muonroi/agent-harness-core/mcp-server";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";

/** Shared async-tool deps for tests; the new wait_for_event heartbeat reads pid/startedAt. */
const fakeAsyncDeps: AsyncToolDeps = {
  onStop: () => {},
  getPid: () => 12345,
  getStartedAt: () => Date.now() - 1000,
};

type ToolCb = (input: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  const tools = new Map<string, ToolCb>();
  return {
    server: {
      registerTool: (name: string, _config: unknown, cb: ToolCb) => {
        tools.set(name, cb);
      },
    } as any,
    invoke: async (name: string, input: Record<string, unknown> = {}) => {
      const cb = tools.get(name);
      if (!cb) throw new Error(`tool not registered: ${name}`);
      return cb(input);
    },
    names: () => Array.from(tools.keys()),
  };
}

type StubOpts = {
  waitRejects?: boolean;
  expectResult?: boolean;
  lastEvent?: LiveEvent | null;
};
function makeStubDriver(opts: StubOpts = {}): Driver {
  return {
    snapshot: () => null,
    changes_since: () => null,
    press: () => {},
    press_sequence: () => {},
    type: () => {},
    focus: () => {},
    wait_for: async () => {
      if (opts.waitRejects) throw new Error("wait_for timeout after 30ms");
    },
    query: () => null,
    queryAll: () => [],
    count: () => 0,
    expect: () => opts.expectResult ?? true,
    last_event: (() => opts.lastEvent ?? null) as Driver["last_event"],
    events: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as any, done: true as const }) }),
    }),
    render_text: () => "",
    snapshot_visual: () => null,
    render_visual: () => "",
    visual_cell: () => null,
    visual_quality: () => null,
    _ingest: () => {},
    _closeAllSubscribers: () => {},
  };
}

describe("registerAsyncTools", () => {
  it("registers all 5 async tools", () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), fakeAsyncDeps);
    expect(fake.names().sort()).toEqual([
      "tui.expect",
      "tui.last_event",
      "tui.stop",
      "tui.wait_for",
      "tui.wait_for_event",
    ]);
  });

  it("tui.wait_for returns ok on success", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.wait_for", { idle: true, timeoutMs: 1000 });
    expect(r.content[0].text).toBe("ok");
  });

  it("tui.wait_for returns isError on timeout", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ waitRejects: true }), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.wait_for", { selector: "role=missing", timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("timeout");
  });

  it("tui.expect returns 'true' string", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ expectResult: true }), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(r.content[0].text).toBe("true");
  });

  it("tui.expect returns 'false' string", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ expectResult: false }), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(r.content[0].text).toBe("false");
  });

  it("tui.last_event returns event JSON or null", async () => {
    const evt: LiveEvent = { t: "event", kind: "toast", level: "info", text: "hi" };
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ lastEvent: evt }), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.last_event", { kind: "toast" });
    expect(JSON.parse(r.content[0].text).kind).toBe("toast");
  });

  it("tui.last_event returns null when no event", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), fakeAsyncDeps);
    const r: any = await fake.invoke("tui.last_event", { kind: "stream.delta" });
    expect(JSON.parse(r.content[0].text)).toBeNull();
  });

  it("tui.stop invokes onStop", async () => {
    let stopped = false;
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), {
      ...fakeAsyncDeps,
      onStop: () => {
        stopped = true;
      },
    });
    const r: any = await fake.invoke("tui.stop");
    expect(stopped).toBe(true);
    expect(r.content[0].text).toBe("ok");
  });

  it("returns no_driver error when getDriver returns null (wait_for/expect/last_event)", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => null, fakeAsyncDeps);
    const a: any = await fake.invoke("tui.wait_for", { idle: true });
    expect(a.isError).toBe(true);
    const b: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(b.isError).toBe(true);
    const c: any = await fake.invoke("tui.last_event", { kind: "toast" });
    expect(c.isError).toBe(true);
  });
});

/**
 * A /ideal run sat on an askcard for 17 minutes while a DB-poll watcher saw
 * nothing — askcard-open writes no DB row. The driver could already wait on an
 * event kind (buildCheck in driver.ts); only this MCP schema withheld it, so
 * every external agent fell back to polling. These pin the wait args that
 * actually reach the driver, because the driver dispatches on `"selector" in
 * args` before `"event" in args` — an undefined-but-present selector key waits
 * on nothing, forever, silently.
 */
describe("tui.wait_for — event conditions", () => {
  function captureArgs() {
    const seen: Record<string, unknown>[] = [];
    const driver = {
      ...makeStubDriver(),
      wait_for: async (args: Record<string, unknown>) => {
        seen.push(args);
      },
    } as unknown as Driver;
    return { driver, seen };
  }

  it("forwards an event condition to the driver", async () => {
    const fake = makeFakeServer();
    const { driver, seen } = captureArgs();
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for", { event: "askcard-open", timeoutMs: 600_000 });

    expect(r.content[0].text).toBe("ok");
    expect(seen[0]).toEqual({ event: "askcard-open", timeoutMs: 600_000 });
  });

  /**
   * makeFakeServer ignores the registered config, so the tests above would pass
   * even with `event` absent from the schema — a real MCP client's zod
   * validation would reject the call long before the driver saw it. The schema
   * IS the boundary that was broken, so assert it directly.
   */
  it("advertises event and a 10-minute ceiling in the declared schema", async () => {
    const configs = new Map<string, any>();
    const server = {
      registerTool: (name: string, config: unknown, _cb: unknown) => configs.set(name, config),
    } as any;
    registerAsyncTools(server, () => makeStubDriver(), fakeAsyncDeps);

    const schema = configs.get("tui.wait_for").inputSchema;
    expect(schema.event).toBeDefined();
    expect(schema.event.safeParse("askcard-open").success).toBe(true);
    // A 60s ceiling forced callers to re-issue the wait — polling in disguise.
    expect(schema.timeoutMs.safeParse(600_000).success).toBe(true);
    // Nested all[] conditions must accept an event too.
    expect(schema.all.safeParse([{ event: "sprint-halt" }]).success).toBe(true);
  });

  it("never leaks an undefined selector key alongside an event", async () => {
    const fake = makeFakeServer();
    const { driver, seen } = captureArgs();
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);

    // Shape an SDK sends when the caller omitted the optional selector.
    await fake.invoke("tui.wait_for", { selector: undefined, idle: undefined, event: "sprint-halt" });

    // `"selector" in args` would be true and win the driver's dispatch.
    expect("selector" in seen[0]).toBe(false);
    expect(seen[0]).toEqual({ event: "sprint-halt" });
  });

  it("keeps selector authoritative when both are given", async () => {
    const fake = makeFakeServer();
    const { driver, seen } = captureArgs();
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);
    await fake.invoke("tui.wait_for", { selector: "id=askcard", event: "askcard-open" });
    expect(seen[0]).toEqual({ selector: "id=askcard" });
  });

  it("forwards event conditions nested in all[]", async () => {
    const fake = makeFakeServer();
    const { driver, seen } = captureArgs();
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);

    await fake.invoke("tui.wait_for", {
      all: [{ event: "sprint-halt" }, { idle: true }],
      timeoutMs: 1000,
    });

    expect(seen[0]).toEqual({ all: [{ event: "sprint-halt" }, { idle: true }], timeoutMs: 1000 });
  });
});

/**
 * Change 1 — tui.wait_for now carries the matched LiveEvent inline for `event`
 * conditions, so the caller no longer needs a follow-up tui.last_event.
 */
describe("tui.wait_for — inline event payload (Change 1)", () => {
  it("returns { ok, event } when an event condition resolves with a payload", async () => {
    const fake = makeFakeServer();
    const matchedEvent: LiveEvent = {
      t: "event",
      kind: "council-step",
      phaseId: "p1",
      phaseKind: "clarification",
      state: "done",
      label: "Clarification",
    } as LiveEvent;
    const driver = {
      ...makeStubDriver(),
      wait_for: async () => ({ event: matchedEvent }),
    } as unknown as Driver;
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for", { event: "council-step", timeoutMs: 1000 });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.event.kind).toBe("council-step");
    expect(parsed.event.state).toBe("done");
  });

  it("still returns bare 'ok' for selector/idle conditions (backward compatible)", async () => {
    const fake = makeFakeServer();
    const driver = {
      ...makeStubDriver(),
      wait_for: async () => undefined,
    } as unknown as Driver;
    registerAsyncTools(fake.server, () => driver, fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for", { idle: true, timeoutMs: 1000 });
    expect(r.content[0].text).toBe("ok");
  });
});

/**
 * Change 2 — tui.wait_for_event streams heartbeat rows + matching events and
 * resolves on `until`, `maxEvents`, `timeoutMs`, or iterator close.
 */
describe("tui.wait_for_event — streaming (Change 2)", () => {
  /** Build a stub driver whose events() iterator yields a scripted event list. */
  function scriptedDriver(events: LiveEvent[], opts: { lastEvent?: LiveEvent | null } = {}): Driver {
    let i = 0;
    const iter = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (i < events.length) {
            return { value: events[i++], done: false as const };
          }
          return { value: undefined, done: true as const };
        },
        return: async () => ({ value: undefined, done: true as const }),
      }),
    };
    return {
      ...makeStubDriver({ lastEvent: opts.lastEvent ?? null }),
      events: () => iter,
    } as unknown as Driver;
  }

  it("delivers matching events and resolves on `until`", async () => {
    const fake = makeFakeServer();
    const events: LiveEvent[] = [
      { t: "event", kind: "council-speaker", role: "Alpha", status: "start", correlationId: "c1" } as LiveEvent,
      {
        t: "event",
        kind: "council-speaker",
        role: "Alpha",
        status: "tick",
        correlationId: "c1",
        elapsedMs: 1000,
      } as LiveEvent,
      {
        t: "event",
        kind: "council-step",
        phaseId: "p1",
        phaseKind: "clarification",
        state: "done",
        label: "Clarification",
      } as LiveEvent,
    ];
    registerAsyncTools(fake.server, () => scriptedDriver(events), fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for_event", {
      filter: ["council-speaker", "council-step"],
      heartbeatMs: 0, // disable heartbeats for a deterministic event-only result
      until: { event: "council-step", state: "done" },
      timeoutMs: 1000,
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.delivered).toBe(3);
    const eventRows = parsed.rows.filter((row: any) => row.type === "event");
    expect(eventRows.length).toBe(3);
    // The terminal row records the until reason.
    const terminalRow = parsed.rows[parsed.rows.length - 1];
    expect(terminalRow.terminal).toBe(true);
    expect(terminalRow.reason).toBe("until");
  });

  it("respects maxEvents", async () => {
    const fake = makeFakeServer();
    const events: LiveEvent[] = Array.from({ length: 10 }, (_, k) => ({
      t: "event",
      kind: "llm-token",
      correlationId: "c1",
      delta: "x",
      tokenIndex: k,
    })) as LiveEvent[];
    registerAsyncTools(fake.server, () => scriptedDriver(events), fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for_event", {
      filter: ["llm-token"],
      heartbeatMs: 0,
      maxEvents: 3,
      timeoutMs: 1000,
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.delivered).toBe(3);
    expect(parsed.rows[parsed.rows.length - 1].reason).toBe("maxEvents");
  });

  it("emits heartbeat rows between events when heartbeatMs > 0", async () => {
    const fake = makeFakeServer();
    // A driver whose iterator parks (no events) so the wake-timer fires.
    const parkingDriver = {
      ...makeStubDriver({ lastEvent: null }),
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}), // never resolves
          return: async () => ({ value: undefined, done: true as const }),
        }),
      }),
    } as unknown as Driver;
    registerAsyncTools(fake.server, () => parkingDriver, fakeAsyncDeps);

    const r: any = await fake.invoke("tui.wait_for_event", {
      heartbeatMs: 50,
      timeoutMs: 200,
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(false); // timed out
    const heartbeats = parsed.rows.filter((row: any) => row.type === "heartbeat");
    // At least one heartbeat should have been emitted before the 200ms timeout.
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(parsed.rows[parsed.rows.length - 1].reason).toBe("timeout");
  });

  it("returns no_driver error before any tui.start", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => null, fakeAsyncDeps);
    const r: any = await fake.invoke("tui.wait_for_event", { filter: ["council-step"] });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("no_driver");
  });
});
