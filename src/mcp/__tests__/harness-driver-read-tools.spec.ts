import type { Driver } from "@muonroi/agent-harness-core/driver";
import { registerReadTools } from "@muonroi/agent-harness-core/mcp-server";
import type { LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";
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

function makeStubDriver(frame: LiveFrame, nodes: UINode[]): Driver {
  return {
    snapshot: () => frame,
    changes_since: (seq: number) => (frame.seq > seq ? frame : null),
    press: () => {},
    press_sequence: () => {},
    type: () => {},
    focus: () => {},
    wait_for: async () => {},
    query: (sel: string) =>
      sel === "ambiguous-error"
        ? (() => {
            throw new Error("ambiguous: 2 matches");
          })()
        : (nodes[0] ?? null),
    queryAll: () => nodes,
    count: () => nodes.length,
    expect: () => true,
    last_event: () => null,
    render_text: () => "[rendered]",
    _ingest: () => {},
  };
}

const sampleFrame: LiveFrame = {
  mode: "live",
  version: "0.1.0",
  seq: 7,
  ts: 0,
  nodes: [{ id: "n1", role: "button", name: "Send" }],
};

describe("registerReadTools", () => {
  it("registers all 6 read tools", () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    expect(fake.names().sort()).toEqual([
      "tui.changes_since",
      "tui.count",
      "tui.query",
      "tui.query_all",
      "tui.render_text",
      "tui.snapshot",
    ]);
  });

  it("tui.snapshot returns serialized frame", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.snapshot");
    expect(JSON.parse(r.content[0].text).seq).toBe(7);
  });

  it("tui.changes_since returns null when seq is current", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.changes_since", { seq: 7 });
    expect(JSON.parse(r.content[0].text)).toBeNull();
  });

  it("tui.changes_since returns frame when seq < current", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.changes_since", { seq: 0 });
    expect(JSON.parse(r.content[0].text).seq).toBe(7);
  });

  it("tui.query returns the single node", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.query", { selector: "role=button" });
    expect(JSON.parse(r.content[0].text).id).toBe("n1");
  });

  it("tui.query returns isError on ambiguous", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.query", { selector: "ambiguous-error" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("ambiguous");
  });

  it("tui.query_all returns array", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.query_all", { selector: "*" });
    expect(JSON.parse(r.content[0].text)).toHaveLength(1);
  });

  it("tui.count returns numeric string", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.count", { selector: "*" });
    expect(r.content[0].text).toBe("1");
  });

  it("tui.render_text returns string", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => makeStubDriver(sampleFrame, sampleFrame.nodes));
    const r: any = await fake.invoke("tui.render_text");
    expect(r.content[0].text).toBe("[rendered]");
  });

  it("returns no_driver error when getDriver returns null", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => null);
    const r: any = await fake.invoke("tui.snapshot");
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("no_driver");
  });
});
