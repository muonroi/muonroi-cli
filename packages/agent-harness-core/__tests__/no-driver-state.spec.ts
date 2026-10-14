/**
 * `no_driver` must say WHY there is no driver.
 *
 * "Call tui.start first" is true and useless to the agent that just called
 * tui.start and was refused: a rejected start, a spawn failure, a stopped child,
 * a crashed child and a start never attempted were one indistinguishable
 * response. A graduation run spent five consecutive round-trips re-reading it
 * after a rejected start, then concluded it had to open this package's source.
 */
import { describe, expect, it } from "vitest";
import { buildNoDriverPayload, type HarnessStartState, registerReadTools } from "../src/mcp-server.js";

type ToolCb = (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function makeFakeServer() {
  const tools = new Map<string, ToolCb>();
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in for registration capture.
    server: { registerTool: (name: string, _c: unknown, cb: ToolCb) => tools.set(name, cb) } as any,
    invoke: async (name: string, input: Record<string, unknown> = {}) => {
      const cb = tools.get(name);
      if (!cb) throw new Error(`tool not registered: ${name}`);
      return cb(input);
    },
  };
}

describe("buildNoDriverPayload", () => {
  it("distinguishes 'never attempted' from 'attempted and refused'", () => {
    const never = buildNoDriverPayload();
    const refused = buildNoDriverPayload({
      status: "start-rejected",
      error: "argv_rejected",
      detail: 'args[2] "x" is not in the tui.start argv allowlist.',
    });

    expect(never.status).toBe("never-started");
    expect(refused.status).toBe("start-rejected");
    expect(never.message).not.toBe(refused.message);
  });

  it("tells a refused caller that retrying the same arguments will fail again", () => {
    const p = buildNoDriverPayload({ status: "start-rejected", error: "argv_rejected", detail: "bad arg." });
    expect(p.message).toContain("argv_rejected");
    expect(p.message).toContain("bad arg.");
    expect(p.message).toContain("SAME arguments");
    expect(p.message).toContain("tui.capabilities");
  });

  it("separates a spawn failure from an argument error", () => {
    const p = buildNoDriverPayload({ status: "spawn-failed", detail: "ENOENT: bun" });
    expect(p.message).toContain("ENOENT: bun");
    expect(p.message).toContain("not an argument error");
  });

  it("reports a deliberate stop and a self-exit differently", () => {
    const stopped = buildNoDriverPayload({ status: "stopped" });
    const exited = buildNoDriverPayload({ status: "exited", exitCode: 1 });
    expect(stopped.message).toContain("tui.stop");
    expect(exited.message).toContain("exit code 1");
    expect(stopped.message).not.toBe(exited.message);
  });

  it("echoes the raw transition so a caller can branch on fields, not prose", () => {
    const state: HarnessStartState = { status: "exited", pid: 4242, exitCode: 3, at: 1 };
    expect(buildNoDriverPayload(state).lastStart).toEqual(state);
  });
});

describe("read tools surface the start state", () => {
  it("reports the refusal reason instead of 'Call tui.start first'", async () => {
    const fake = makeFakeServer();
    registerReadTools(
      fake.server,
      () => null,
      () => ({
        status: "start-rejected",
        error: "argv_rejected",
        detail: 'args[2] "tests/harness/fixtures/llm" is not in the tui.start argv allowlist.',
      }),
    );

    const r = await fake.invoke("tui.snapshot");
    const body = JSON.parse(r.content[0]?.text ?? "{}");
    expect(body.error).toBe("no_driver");
    expect(body.status).toBe("start-rejected");
    expect(body.message).toContain("argv_rejected");
    expect(r.isError).toBe(true);
  });

  it("falls back to never-started when no state provider is wired", async () => {
    const fake = makeFakeServer();
    registerReadTools(fake.server, () => null);
    const body = JSON.parse((await fake.invoke("tui.snapshot")).content[0]?.text ?? "{}");
    expect(body.error).toBe("no_driver");
    expect(body.status).toBe("never-started");
  });
});
