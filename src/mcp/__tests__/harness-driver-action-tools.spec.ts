import type { Driver } from "@muonroi/agent-harness-core/driver";
import { registerActionTools } from "@muonroi/agent-harness-core/mcp-server";
import { describe, expect, it } from "vitest";

type ToolCb = (input: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  const tools = new Map<string, ToolCb>();
  return {
    server: {
      registerTool: (name: string, _config: unknown, cb: ToolCb) => {
        tools.set(name, cb);
        return undefined;
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

type Calls = { presses: string[]; sequences: string[][]; types: string[]; focuses: string[] };

function makeStubDriver(
  calls: Calls,
  opts: { focusThrows?: boolean; focusMoves?: boolean; ambiguous?: boolean } = {},
): Driver {
  return {
    snapshot: () => null,
    changes_since: () => null,
    press: (k: string) => {
      calls.presses.push(k);
    },
    press_sequence: (ks: string[]) => {
      calls.sequences.push(ks);
    },
    type: (t: string) => {
      calls.types.push(t);
    },
    focus: (s: string) => {
      if (opts.focusThrows) throw new Error("focus: expected 1 match, got 2");
      calls.focuses.push(s);
    },
    focus_verified: async (s: string) => {
      if (opts.focusThrows) throw new Error("focus: expected 1 match, got 2");
      calls.focuses.push(s);
      if (opts.ambiguous) {
        return { ok: false as const, reason: "ambiguous" as const, matches: 2, message: "expected 1 match, got 2" };
      }
      if (opts.focusMoves) return { ok: true as const, id: "btn" };
      return {
        ok: false as const,
        reason: "not_focusable" as const,
        id: "btn",
        focusHolder: null,
        message: "no frame reported it focused",
      };
    },
    wait_for: async () => {},
    query: () => null,
    queryAll: () => [],
    count: () => 0,
    expect: () => true,
    last_event: () => null,
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

describe("registerActionTools", () => {
  it("registers all 4 action tools", () => {
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver({ presses: [], sequences: [], types: [], focuses: [] }));
    expect(fake.names().sort()).toEqual(["tui.focus", "tui.press", "tui.press_sequence", "tui.type"]);
  });

  it("tui.press dispatches to driver.press", async () => {
    const calls: Calls = { presses: [], sequences: [], types: [], focuses: [] };
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver(calls));
    const r: any = await fake.invoke("tui.press", { key: "Enter" });
    expect(calls.presses).toEqual(["Enter"]);
    expect(r.content[0].text).toBe("ok");
  });

  it("tui.press_sequence dispatches to driver.press_sequence", async () => {
    const calls: Calls = { presses: [], sequences: [], types: [], focuses: [] };
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver(calls));
    await fake.invoke("tui.press_sequence", { keys: ["Down", "Down", "Enter"] });
    expect(calls.sequences).toEqual([["Down", "Down", "Enter"]]);
  });

  it("tui.type dispatches to driver.type", async () => {
    const calls: Calls = { presses: [], sequences: [], types: [], focuses: [] };
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver(calls));
    await fake.invoke("tui.type", { text: "hello world" });
    expect(calls.types).toEqual(["hello world"]);
  });

  it("tui.focus dispatches to driver.focus_verified and reports ok when focus really moved", async () => {
    const calls: Calls = { presses: [], sequences: [], types: [], focuses: [] };
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver(calls, { focusMoves: true }));
    const r: any = await fake.invoke("tui.focus", { selector: "role=button" });
    expect(calls.focuses).toEqual(["role=button"]);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, id: "btn" });
  });

  // Regression pin (2026-09-05): tui.focus used to return the bare string "ok"
  // whether or not focus moved. `__focus__:` is dropped by the OpenTUI input
  // bridge, so that "ok" was a lie for every surface that does not already hold
  // focus — and a driver stuck between two stacked modals had no way to learn
  // its recovery attempt had failed.
  it("tui.focus returns isError when focus did NOT move", async () => {
    const calls: Calls = { presses: [], sequences: [], types: [], focuses: [] };
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => makeStubDriver(calls));
    const r: any = await fake.invoke("tui.focus", { selector: "id=askcard-option-escalate_accept" });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe("not_focusable");
    expect(body.ok).toBe(false);
    expect(String(body.message)).toContain("focused");
  });

  it("tui.focus returns isError on ambiguous selector", async () => {
    const fake = makeFakeServer();
    registerActionTools(fake.server, () =>
      makeStubDriver({ presses: [], sequences: [], types: [], focuses: [] }, { ambiguous: true }),
    );
    const r: any = await fake.invoke("tui.focus", { selector: "role=listitem" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("ambiguous");
  });

  it("tui.focus surfaces a thrown driver error as focus_failed", async () => {
    const fake = makeFakeServer();
    registerActionTools(fake.server, () =>
      makeStubDriver({ presses: [], sequences: [], types: [], focuses: [] }, { focusThrows: true }),
    );
    const r: any = await fake.invoke("tui.focus", { selector: "role=listitem" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("focus_failed");
  });

  it("returns no_driver error when getDriver returns null", async () => {
    const fake = makeFakeServer();
    registerActionTools(fake.server, () => null);
    const r: any = await fake.invoke("tui.press", { key: "x" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("no_driver");
  });
});
