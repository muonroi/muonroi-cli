import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModeRuntime } from "../src/agent-mode.js";
import { startAgentMode } from "../src/agent-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreams() {
  const out = new PassThrough();
  const inn = new PassThrough();
  return { out, inn };
}

async function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const s = Buffer.concat(chunks).toString("utf8");
      const idx = s.indexOf("\n");
      if (idx >= 0) {
        stream.off("data", onData);
        stream.off("error", reject);
        resolve(s.slice(0, idx));
      }
    };
    stream.on("data", onData);
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentMode runtime", () => {
  let rt: AgentModeRuntime;
  let out: PassThrough;
  let inn: PassThrough;

  beforeEach(async () => {
    const streams = makeStreams();
    out = streams.out;
    inn = streams.inn;
    rt = await startAgentMode({
      cols: 80,
      rows: 24,
      idleMs: 5000,
      fakeClock: true,
      injectStreams: { out, in: inn },
    });
  });

  afterEach(() => {
    rt.dispose();
  });

  // Test a: runtime exposes expected shape
  it("a: runtime exposes registry, capture, emitEvent, dispose, onCommand, now", () => {
    expect(rt).toHaveProperty("registry");
    expect(rt).toHaveProperty("capture");
    expect(rt).toHaveProperty("emitEvent");
    expect(rt).toHaveProperty("dispose");
    expect(rt).toHaveProperty("onCommand");
    expect(rt).toHaveProperty("now");
    expect(typeof rt.registry.register).toBe("function");
    expect(typeof rt.capture).toBe("function");
    expect(typeof rt.emitEvent).toBe("function");
    expect(typeof rt.dispose).toBe("function");
    expect(typeof rt.onCommand).toBe("function");
    expect(typeof rt.now).toBe("function");
  });

  // Test b: register + capture writes a LiveFrame JSONL line
  it("b: after registry.register, calling capture() writes a LiveFrame JSONL line", async () => {
    rt.registry.register({ id: "btn1", role: "button", name: "Send" });
    rt.capture();

    const line = await readLine(out);
    const parsed = JSON.parse(line);
    expect(parsed.mode).toBe("live");
    expect(parsed.version).toBe("0.3.0");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toMatchObject({ id: "btn1", role: "button", name: "Send" });
  });

  // Test c: dedup — calling capture() twice with no registry change writes only one frame
  it("c: calling capture() twice with no registry change writes only one frame", async () => {
    rt.registry.register({ id: "btn1", role: "button" });

    rt.capture(); // first — should emit
    rt.capture(); // second — should be deduped (null from hook)

    // Collect all data for a bit
    await new Promise((resolve) => setTimeout(resolve, 30));

    const data = out.read();
    const text = data ? data.toString("utf8") : "";
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.mode).toBe("live");
  });

  // Test d: emitEvent writes a single event line
  it("d: emitEvent({ t: 'event', kind: 'toast', ... }) writes a single event line", async () => {
    rt.emitEvent({ t: "event", kind: "toast", level: "error", text: "Something went wrong" });

    const line = await readLine(out);
    const parsed = JSON.parse(line);
    expect(parsed.t).toBe("event");
    expect(parsed.kind).toBe("toast");
    expect(parsed.level).toBe("error");
    expect(parsed.text).toBe("Something went wrong");
  });

  // Test e: reading a command line on the in stream invokes onCommand handler
  it("e: reading a press command on in stream invokes onCommand handler", async () => {
    const received: unknown[] = [];
    rt.onCommand((cmd) => received.push(cmd));

    // Write a command to the in stream
    inn.write('{"op":"press","key":"Enter"}\n');

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ op: "press", key: "Enter" });
  });

  // Test f: dispose() closes both streams
  it("f: dispose() closes both streams (writableEnded, no further writes)", async () => {
    rt.dispose();

    // Give stream a tick to finish
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(out.writableEnded).toBe(true);
  });
});
