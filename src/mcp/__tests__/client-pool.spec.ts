import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pool reuse semantics: connect a server ONCE, reuse the live client across
// turns, evict on failure (retry) and on a post-connect connection error
// (reconnect), and tear everything down on closeAllMcpClients().

vi.mock("../validate.js", () => ({ validateMcpServerConfig: () => ({ ok: true }) }));

const connectOneServer = vi.fn();
vi.mock("../runtime.js", () => ({
  connectOneServer: (...args: unknown[]) => connectOneServer(...args),
  getMcpBuildDeadlineMs: () => 500,
}));

import {
  __mcpClientPoolSize,
  __resetMcpClientPoolForTests,
  acquireMcpTools,
  closeAllMcpClients,
  warmMcpClients,
} from "../client-pool.js";

const srv = (id: string) =>
  ({ id, label: id, enabled: true, transport: "stdio" as const, command: "x", args: [] }) as never;

const connected = (id: string, close: () => Promise<void> = async () => {}) => ({
  tools: { [`mcp_${id}__ping`]: { execute: async () => "pong" } },
  client: { close },
});

describe("acquireMcpTools — cross-turn client pool", () => {
  beforeEach(() => {
    __resetMcpClientPoolForTests();
    connectOneServer.mockReset();
  });
  afterEach(async () => {
    await closeAllMcpClients();
  });

  it("connects a server once and reuses it across turns (no per-turn cold-spawn)", async () => {
    connectOneServer.mockImplementation(async (s: { id: string }) => connected(s.id));

    const b1 = await acquireMcpTools([srv("fs")]);
    expect(Object.keys(b1.tools)).toContain("mcp_fs__ping");
    await b1.close(); // release — must NOT kill the pooled client

    const b2 = await acquireMcpTools([srv("fs")]);
    expect(Object.keys(b2.tools)).toContain("mcp_fs__ping");
    expect(connectOneServer).toHaveBeenCalledTimes(1); // reused, not re-spawned
  });

  it("evicts a failed connect so a later turn retries", async () => {
    connectOneServer
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockImplementation(async (s: { id: string }) => connected(s.id));

    const b1 = await acquireMcpTools([srv("fs")]);
    expect(b1.errors.some((e) => e.includes("fs"))).toBe(true);
    expect(Object.keys(b1.tools)).not.toContain("mcp_fs__ping");

    const b2 = await acquireMcpTools([srv("fs")]);
    expect(Object.keys(b2.tools)).toContain("mcp_fs__ping");
    expect(connectOneServer).toHaveBeenCalledTimes(2); // retried after eviction
  });

  it("self-heals: a connection error reconnects ONCE in-turn; a permanently-dead server surfaces the error (no loop)", async () => {
    connectOneServer.mockImplementation(async (s: { id: string }) => ({
      tools: {
        [`mcp_${s.id}__boom`]: {
          execute: async () => {
            throw new Error("MCP transport closed");
          },
        },
      },
      client: { close: async () => {} },
    }));

    const b1 = await acquireMcpTools([srv("fs")]);
    await expect(
      (b1.tools.mcp_fs__boom as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute({}, {}),
    ).rejects.toThrow(/transport closed/);

    // Initial connect + exactly ONE in-turn reconnect — the retry is not looped.
    expect(connectOneServer).toHaveBeenCalledTimes(2);
  });

  it("in-turn reconnect: a mid-turn transport drop is reconnected and the call retried once — succeeds", async () => {
    let gen = 0;
    connectOneServer.mockImplementation(async (s: { id: string }) => {
      gen += 1;
      const dead = gen === 1; // first connect drops mid-call; the reconnect is healthy
      return {
        tools: {
          [`mcp_${s.id}__ping`]: {
            execute: async () => {
              if (dead) throw new Error("Attempted to send a request from a closed client");
              return "pong";
            },
          },
        },
        client: { close: async () => {} },
      };
    });

    const b = await acquireMcpTools([srv("docs")]);
    const result = await (b.tools.mcp_docs__ping as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      {},
      {},
    );
    expect(result).toBe("pong"); // recovered within the SAME turn
    expect(connectOneServer).toHaveBeenCalledTimes(2); // drop + one reconnect
  });

  it("a parallel burst on a dropped client shares ONE reconnect; every call retries and succeeds", async () => {
    // Repro of session 41ccfeb2ceee: a 14-call burst at muonroi-docs dropped the
    // HTTP socket after the first calls; previously the rest all threw
    // "Attempted to send a request from a closed client". They must now share a
    // single reconnect and all recover.
    let gen = 0;
    connectOneServer.mockImplementation(async (s: { id: string }) => {
      gen += 1;
      const dead = gen === 1;
      return {
        tools: {
          [`mcp_${s.id}__ping`]: {
            execute: async () => {
              if (dead) throw new Error("The socket connection was closed unexpectedly");
              return "pong";
            },
          },
        },
        client: { close: async () => {} },
      };
    });

    const b = await acquireMcpTools([srv("docs")]);
    const tool = b.tools.mcp_docs__ping as { execute: (a: unknown, o: unknown) => Promise<unknown> };
    const results = await Promise.all(Array.from({ length: 14 }, () => tool.execute({}, {})));
    expect(results.every((r) => r === "pong")).toBe(true);
    expect(connectOneServer).toHaveBeenCalledTimes(2); // 14 failures → exactly ONE shared reconnect
  });

  it("waits for a criticalServerId past the normal deadline so it lands THIS turn (session 584ba476c07a)", async () => {
    // Normal deadline is 500ms (mock). docs connects at ~700ms — past the normal
    // deadline but within the critical window → must be included when critical.
    connectOneServer.mockImplementation(
      (s: { id: string }) =>
        new Promise((res) => {
          if (s.id === "docs") setTimeout(() => res(connected(s.id)), 700);
          else res(connected(s.id));
        }),
    );
    const b = await acquireMcpTools([srv("docs")], { criticalServerIds: ["docs"], criticalDeadlineMs: 3000 });
    expect(Object.keys(b.tools)).toContain("mcp_docs__ping");
    expect(b.errors).toHaveLength(0);
  });

  it("without criticalServerIds, a slow server is reported still-connecting (available next turn)", async () => {
    connectOneServer.mockImplementation(
      (s: { id: string }) =>
        new Promise((res) => {
          setTimeout(() => res(connected(s.id)), 700);
        }),
    );
    const b = await acquireMcpTools([srv("docs")]);
    expect(Object.keys(b.tools)).not.toContain("mcp_docs__ping");
    expect(b.errors.some((e) => /still connecting/.test(e))).toBe(true);
  });

  it("keys by cwd/config — a different command reconnects rather than reusing", async () => {
    connectOneServer.mockImplementation(async (s: { id: string }) => connected(s.id));
    await acquireMcpTools([
      { id: "fs", label: "fs", enabled: true, transport: "stdio", command: "a", args: [] } as never,
    ]);
    await acquireMcpTools([
      { id: "fs", label: "fs", enabled: true, transport: "stdio", command: "b", args: [] } as never,
    ]);
    expect(connectOneServer).toHaveBeenCalledTimes(2);
  });

  it("warmMcpClients pre-connects so the first real turn reuses (no extra spawn)", async () => {
    let resolveConnect: () => void = () => {};
    connectOneServer.mockImplementation(
      (s: { id: string }) =>
        new Promise((res) => {
          resolveConnect = () => res(connected(s.id));
        }),
    );
    // Warm starts the connect in the background.
    warmMcpClients([srv("fs")]);
    expect(connectOneServer).toHaveBeenCalledTimes(1);
    expect(__mcpClientPoolSize()).toBe(1);
    // Let the warm connect finish, then a real turn reuses it.
    resolveConnect();
    await new Promise((r) => setTimeout(r, 0));
    const b = await acquireMcpTools([srv("fs")]);
    expect(Object.keys(b.tools)).toContain("mcp_fs__ping");
    expect(connectOneServer).toHaveBeenCalledTimes(1); // warmed, not re-spawned
  });

  it("closeAllMcpClients tears down every pooled client", async () => {
    const closeSpy = vi.fn(async () => {});
    connectOneServer.mockImplementation(async (s: { id: string }) => connected(s.id, closeSpy));

    await acquireMcpTools([srv("fs"), srv("mem")]);
    expect(__mcpClientPoolSize()).toBe(2);

    await closeAllMcpClients();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(__mcpClientPoolSize()).toBe(0);
  });
});
