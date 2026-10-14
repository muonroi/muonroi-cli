/**
 * tui-stop-kill.spec.ts — regression for P0-3.
 *
 * Measured 2026-09-03: all 8 TUIs started in one MCP session survived
 * `tui_stop`. `tui.stop` returned the string "ok" unconditionally while
 * `onStop` only tore down the notification bridge and nulled
 * `currentDriver` / `currentPid` / `currentStartedAt`. It never called
 * `kill()` and structurally could not: the child handle was destructured
 * inside `tui.start` and never stored in module scope — only the pid was.
 * An unattended loop that starts a TUI per sprint therefore leaked one
 * process per sprint.
 *
 * These lock the two halves of the fix:
 *   1. `killHarnessChild` actually signals, tolerates an already-exited
 *      child without throwing, and escalates to SIGKILL after the grace
 *      period.
 *   2. The server wiring reaches it: `tui.start` stores the child handle and
 *      `tui.stop` kills it — asserted over the exit criterion's 10
 *      start/stop cycles with a survivor count of 0.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpHarnessServer,
  type HarnessSpawn,
  type HarnessSpawnResult,
  killHarnessChild,
} from "../src/mcp-server.js";

// ---------------------------------------------------------------------------
// Fake child — the whole point is that the stop path is reachable WITHOUT a
// real spawn. The bug shipped precisely because it was only reachable with one.
// ---------------------------------------------------------------------------

type FakeChild = {
  result: HarnessSpawnResult;
  /** Still running? The survivor count of the exit criterion. */
  alive: () => boolean;
  /** Every signal kill() was called with, in order (undefined = default). */
  killSignals: () => Array<string | undefined>;
};

function makeFakeChild(pid: number, opts: { ignoreKill?: boolean } = {}): FakeChild {
  let alive = true;
  const killSignals: Array<string | undefined> = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const proc = {
    pid,
    kill(signal?: string): boolean {
      killSignals.push(signal);
      if (!alive) return false;
      // A child that ignores SIGTERM stays alive until SIGKILL — the case the
      // escalation timer exists for.
      if (opts.ignoreKill && signal !== "SIGKILL") return true;
      alive = false;
      resolveExit(0);
      return true;
    },
  };
  return {
    result: { proc, sendLine: () => {}, onLine: () => () => {}, exited },
    alive: () => alive,
    killSignals: () => killSignals,
  };
}

describe("killHarnessChild", () => {
  it("returns a no_child outcome instead of throwing when nothing is running", () => {
    expect(killHarnessChild(null)).toEqual({ ok: true, killed: false, reason: "no_child" });
    expect(killHarnessChild(undefined)).toEqual({ ok: true, killed: false, reason: "no_child" });
  });

  it("kills a live child and reports it", () => {
    const child = makeFakeChild(4242);
    const out = killHarnessChild(child.result.proc, child.result.exited);
    expect(out).toEqual({ ok: true, killed: true, pid: 4242 });
    expect(child.alive()).toBe(false);
  });

  it("treats an already-exited child as success (kill() returning false)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const child = makeFakeChild(7);
      killHarnessChild(child.result.proc, child.result.exited);
      // Second stop on the same handle: kill() now returns false.
      const out = killHarnessChild(child.result.proc, child.result.exited);
      expect(out.ok).toBe(true);
      expect(out.killed).toBe(false);
      expect(out.reason).toBe("already_exited");
      // No Silent Catch Rule: the non-delivery is logged with module + pid.
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("agent-harness-core/mcp-server"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("treats a throwing kill() (ESRCH / process not found) as success and logs it", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = killHarnessChild({
        pid: 99,
        kill: () => {
          throw new Error("kill ESRCH");
        },
      });
      expect(out.ok).toBe(true);
      expect(out.killed).toBe(false);
      expect(out.reason).toBe("already_exited");
      expect(out.error).toContain("ESRCH");
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("kill ESRCH"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("escalates to SIGKILL when the child ignores the polite signal", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const child = makeFakeChild(1234, { ignoreKill: true });
      killHarnessChild(child.result.proc, child.result.exited, 10);
      expect(child.alive()).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      expect(child.killSignals()).toContain("SIGKILL");
      expect(child.alive()).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not escalate when the child exits within the grace period", async () => {
    const child = makeFakeChild(5555);
    killHarnessChild(child.result.proc, child.result.exited, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(child.killSignals()).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------
// Server wiring — the half that was actually broken.
// ---------------------------------------------------------------------------

async function connectHarness(spawn: HarnessSpawn): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpHarnessServer({ spawn });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tui-stop-kill-spec", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

describe("tui.stop kills the child (P0-3)", () => {
  const prevEventLog = process.env.MUONROI_HARNESS_EVENT_LOG;
  beforeEach(() => {
    // Keep the spec from writing a JSONL sink into the temp dir on every start.
    process.env.MUONROI_HARNESS_EVENT_LOG = "0";
  });
  afterEach(() => {
    if (prevEventLog === undefined) delete process.env.MUONROI_HARNESS_EVENT_LOG;
    else process.env.MUONROI_HARNESS_EVENT_LOG = prevEventLog;
  });

  it("signals the spawned child and still answers ok", async () => {
    const child = makeFakeChild(31337);
    const { client, close } = await connectHarness(async () => child.result);
    try {
      const started = await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
      expect(JSON.parse(textOf(started)).pid).toBe(31337);
      expect(child.alive()).toBe(true);

      const stopped = await client.callTool({ name: "tui.stop", arguments: {} });
      expect(textOf(stopped)).toBe("ok");
      // The regression: before the fix this was still true.
      expect(child.alive()).toBe(false);
      expect(child.killSignals().length).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it("leaves 0 survivors across 10 start/stop cycles (exit criterion)", async () => {
    const children: FakeChild[] = [];
    let n = 0;
    const spawn: HarnessSpawn = async () => {
      const c = makeFakeChild(9000 + n++);
      children.push(c);
      return c.result;
    };
    const { client, close } = await connectHarness(spawn);
    try {
      for (let i = 0; i < 10; i++) {
        const started = await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
        expect(JSON.parse(textOf(started)).ok).toBe(true);
        await client.callTool({ name: "tui.stop", arguments: {} });
      }
      expect(children).toHaveLength(10);
      const survivors = children.filter((c) => c.alive());
      expect(survivors.map((c) => c.result.proc.pid)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("stopping twice, or with no child, does not throw and still reports ok", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const child = makeFakeChild(4321);
    const { client, close } = await connectHarness(async () => child.result);
    try {
      // No child at all.
      expect(textOf(await client.callTool({ name: "tui.stop", arguments: {} }))).toBe("ok");
      await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
      expect(textOf(await client.callTool({ name: "tui.stop", arguments: {} }))).toBe("ok");
      // Second stop: the handle is already cleared, so this is the no_child path.
      expect(textOf(await client.callTool({ name: "tui.stop", arguments: {} }))).toBe("ok");
      expect(child.killSignals()).toEqual([undefined]);
    } finally {
      await close();
      errSpy.mockRestore();
    }
  });

  it("a stopped harness can be started again (state was fully released)", async () => {
    const children: FakeChild[] = [];
    let n = 0;
    const { client, close } = await connectHarness(async () => {
      const c = makeFakeChild(500 + n++);
      children.push(c);
      return c.result;
    });
    try {
      await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
      // A second start while one is live must still be rejected.
      const dup = await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
      expect(JSON.parse(textOf(dup)).error).toBe("already_started");
      await client.callTool({ name: "tui.stop", arguments: {} });
      const again = await client.callTool({ name: "tui.start", arguments: { args: ["--agent-mode"] } });
      expect(JSON.parse(textOf(again)).ok).toBe(true);
      expect(children).toHaveLength(2);
      await client.callTool({ name: "tui.stop", arguments: {} });
      expect(children.filter((c) => c.alive())).toEqual([]);
    } finally {
      await close();
    }
  });
});
