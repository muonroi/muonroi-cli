import type { Driver } from "@muonroi/agent-harness-core/driver";
import { registerAsyncTools } from "@muonroi/agent-harness-core/mcp-server";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";

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
    last_event: () => opts.lastEvent ?? null,
    render_text: () => "",
    _ingest: () => {},
  };
}

describe("registerAsyncTools", () => {
  it("registers all 4 async tools", () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), { onStop: () => {} });
    expect(fake.names().sort()).toEqual(["tui.expect", "tui.last_event", "tui.stop", "tui.wait_for"]);
  });

  it("tui.wait_for returns ok on success", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), { onStop: () => {} });
    const r: any = await fake.invoke("tui.wait_for", { idle: true, timeoutMs: 1000 });
    expect(r.content[0].text).toBe("ok");
  });

  it("tui.wait_for returns isError on timeout", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ waitRejects: true }), { onStop: () => {} });
    const r: any = await fake.invoke("tui.wait_for", { selector: "role=missing", timeoutMs: 30 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("timeout");
  });

  it("tui.expect returns 'true' string", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ expectResult: true }), { onStop: () => {} });
    const r: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(r.content[0].text).toBe("true");
  });

  it("tui.expect returns 'false' string", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ expectResult: false }), { onStop: () => {} });
    const r: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(r.content[0].text).toBe("false");
  });

  it("tui.last_event returns event JSON or null", async () => {
    const evt: LiveEvent = { t: "event", kind: "toast", level: "info", text: "hi" };
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver({ lastEvent: evt }), { onStop: () => {} });
    const r: any = await fake.invoke("tui.last_event", { kind: "toast" });
    expect(JSON.parse(r.content[0].text).kind).toBe("toast");
  });

  it("tui.last_event returns null when no event", async () => {
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), { onStop: () => {} });
    const r: any = await fake.invoke("tui.last_event", { kind: "stream.delta" });
    expect(JSON.parse(r.content[0].text)).toBeNull();
  });

  it("tui.stop invokes onStop", async () => {
    let stopped = false;
    const fake = makeFakeServer();
    registerAsyncTools(fake.server, () => makeStubDriver(), {
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
    registerAsyncTools(fake.server, () => null, { onStop: () => {} });
    const a: any = await fake.invoke("tui.wait_for", { idle: true });
    expect(a.isError).toBe(true);
    const b: any = await fake.invoke("tui.expect", { selector: "x", predicate: {} });
    expect(b.isError).toBe(true);
    const c: any = await fake.invoke("tui.last_event", { kind: "toast" });
    expect(c.isError).toBe(true);
  });
});
