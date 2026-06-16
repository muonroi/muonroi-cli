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

  it("self-heals: a tool hitting a connection error evicts the client so the next turn reconnects", async () => {
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
      (b1.tools["mcp_fs__boom"] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute({}, {}),
    ).rejects.toThrow(/transport closed/);

    const b2 = await acquireMcpTools([srv("fs")]);
    expect(b2).toBeDefined();
    expect(connectOneServer).toHaveBeenCalledTimes(2); // reconnected after the connection error
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
