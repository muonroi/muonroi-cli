/**
 * src/mcp/client-pool.ts
 *
 * Cross-turn MCP client pool. The orchestrator rebuilds its tool set every turn
 * (and closes it in a `finally`), which previously cold-spawned EVERY stdio MCP
 * server (npx filesystem/playwright/fetch/tavily/…) on every turn — each spawn
 * costs ~1-3s and raced the build deadline. This pool connects each server ONCE
 * and reuses the live client across turns: only the first turn that needs a
 * server pays the cold-start; later turns select its (already-built) tools
 * instantly. Real teardown happens once on orchestrator/process shutdown.
 *
 * Per-turn smart-filtering is unchanged — the caller still passes only the
 * servers relevant to this message; the pool just avoids re-spawning the ones
 * it has already connected.
 *
 * Self-healing: a server that fails to connect is evicted (not cached as a
 * rejection), so a later turn retries. A live client whose child process dies
 * later is evicted when one of its tool calls hits a transport/connection error.
 *
 * In-turn reconnect: a transport that drops MID-TURN (live: muonroi-docs HTTP
 * socket closed after 2 of a 14-call parallel burst, session 41ccfeb2ceee —
 * every remaining call then threw "Attempted to send a request from a closed
 * client") is reconnected and the failing call is retried ONCE against the fresh
 * client, instead of only reconnecting on the NEXT turn. Concurrent failures in
 * the same burst share one reconnect (the pool dedupes by key); eviction is
 * race-safe so a fresh reconnect is never torn down by a sibling's late failure.
 */

import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings.js";
import {
  type ConnectedServer,
  connectOneServer,
  getMcpBuildDeadlineMs,
  type McpBuildOptions,
  type McpToolBundle,
} from "./runtime.js";
import { validateMcpServerConfig } from "./validate.js";

interface PoolEntry {
  key: string;
  promise: Promise<ConnectedServer>;
  /**
   * The resolved server, set once `promise` fulfils. Lets the in-turn self-heal
   * evict ONLY the specific dead client by object identity — never a fresh
   * reconnect that a sibling failure raced in between (see evictDeadServer).
   */
  connected?: ConnectedServer;
}

const pool = new Map<string, PoolEntry>();

/**
 * Stable identity for a connected server. Includes cwd (stdio servers like
 * filesystem inherit it) + command/args/url/env so a config or cwd change
 * reconnects instead of reusing a stale client.
 */
function serverKey(s: McpServerConfig): string {
  return JSON.stringify({
    id: s.id,
    transport: s.transport,
    command: s.command ?? null,
    args: s.args ?? null,
    url: s.url ?? null,
    headers: s.headers ?? null,
    env: s.env ?? null,
    cwd: s.cwd ?? process.cwd(),
  });
}

/**
 * Tear down a pooled entry ONLY if it still holds `dead` (the specific server a
 * failing tool call was bound to). Race-safe under a parallel burst: when 14
 * sibling calls all fail on the same dropped client, the first evicts it and
 * reconnects; the rest find `entry.connected !== dead` (a fresh client, or no
 * entry) and leave the reconnect untouched. Best-effort cleanup of the dead one.
 */
function evictDeadServer(key: string, dead: ConnectedServer): void {
  const entry = pool.get(key);
  if (!entry || entry.connected !== dead) return;
  pool.delete(key);
  dead.cleanup?.();
  void dead.client.close().catch(() => {});
}

/** Heuristic: does this error mean the MCP transport/child is gone? */
function isConnectionError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("closed") ||
    msg.includes("disconnect") ||
    msg.includes("econnrefused") ||
    msg.includes("epipe") ||
    msg.includes("transport") ||
    msg.includes("not connected") ||
    msg.includes("terminated")
  );
}

/** Connect a server (or reuse the live cached client). Evicts on connect failure. */
function getOrConnect(server: McpServerConfig, opts?: McpBuildOptions): Promise<ConnectedServer> {
  const key = serverKey(server);
  const existing = pool.get(key);
  if (existing) return existing.promise;
  const promise = connectOneServer(server, opts);
  const entry: PoolEntry = { key, promise };
  pool.set(key, entry);
  promise.then(
    // Record the resolved server so evictDeadServer can match by identity.
    (cs) => {
      entry.connected = cs;
    },
    // Cache a rejection only transiently: evict so the next turn retries rather
    // than returning the same failed promise forever.
    () => {
      if (pool.get(key) === entry) pool.delete(key);
    },
  );
  return promise;
}

/**
 * Wrap each tool's execute so a transport/connection failure is recovered
 * in-turn: evict the dead pooled client (race-safe), reconnect once, and retry
 * the SAME call against the fresh client. Before this, a mid-turn drop only
 * reconnected on the NEXT turn, so the rest of the current turn's batch all
 * failed with "Attempted to send a request from a closed client". The MCP child
 * may also die after a successful connect; the eviction keeps the pool clean for
 * later turns either way.
 *
 * The retry is fired at most ONCE per call (no loop): if the fresh client also
 * drops, or the reconnect itself fails, the original transport error propagates
 * so the model sees a real failure rather than hanging.
 */
function wrapForSelfHeal(cs: ConnectedServer, key: string, server: McpServerConfig, opts?: McpBuildOptions): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(cs.tools)) {
    const base = (tool as { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
    if (typeof base !== "function") {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...(tool as object),
      execute: async (args: unknown, options: unknown) => {
        try {
          return await base(args, options);
        } catch (e) {
          if (!isConnectionError(e)) throw e;
          console.error(
            `[mcp:pool] '${name}' hit a connection error — reconnecting '${server.id}' in-turn and retrying once: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          // Evict THIS dead client (no-op if a sibling already reconnected), then
          // reconnect. getOrConnect dedupes by key, so a burst shares one reconnect.
          evictDeadServer(key, cs);
          let fresh: ConnectedServer;
          try {
            fresh = await getOrConnect(server, opts);
          } catch (reconnectErr) {
            console.error(
              `[mcp:pool] in-turn reconnect for '${server.id}' failed; surfacing original error: ${
                reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)
              }`,
            );
            throw e;
          }
          const freshTools = fresh.tools as Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }>;
          const freshExec = freshTools[name]?.execute;
          if (typeof freshExec !== "function") throw e;
          return await freshExec(args, options);
        }
      },
    } as ToolSet[string];
  }
  return out;
}

/**
 * Acquire the tool set for `servers`, reusing pooled clients where possible.
 * Mirrors buildMcpToolSet's parallel + partial-at-deadline contract, but only
 * FIRST-connects can be slow — already-pooled servers resolve instantly. The
 * returned bundle's `close()` is a no-op RELEASE: pooled clients stay alive for
 * the next turn. Use closeAllMcpClients() for real teardown.
 */
export async function acquireMcpTools(servers: McpServerConfig[], opts?: McpBuildOptions): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];

  const enabled = servers.filter((s) => s.enabled);
  interface Slot {
    label: string;
    key: string;
    done: boolean;
    result?: ConnectedServer;
    error?: string;
  }
  const slots: Slot[] = enabled.map((s) => ({ label: s.label, key: serverKey(s), done: false }));

  const attempts = enabled.map((server, i) => {
    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      slots[i] = { ...slots[i]!, done: true, error: validation.error };
      return Promise.resolve();
    }
    return getOrConnect(server, opts).then(
      (result) => {
        slots[i] = { ...slots[i]!, done: true, result };
      },
      (error: unknown) => {
        slots[i] = { ...slots[i]!, done: true, error: error instanceof Error ? error.message : String(error) };
      },
    );
  });

  const deadlineMs = getMcpBuildDeadlineMs();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, deadlineMs);
    deadlineTimer.unref?.();
  });
  await Promise.race([Promise.allSettled(attempts), deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (slot.done) {
      if (slot.error) {
        errors.push(`${slot.label}: ${slot.error}`);
      } else if (slot.result) {
        Object.assign(tools, wrapForSelfHeal(slot.result, slot.key, enabled[i]!, opts));
      }
    } else {
      // Still connecting at the deadline (a cold first-connect). It stays in the
      // pool and will be ready for a later turn — just excluded from THIS turn.
      errors.push(`${slot.label}: not ready within ${deadlineMs}ms (still connecting — available next turn)`);
    }
  }

  if (errors.length > 0) {
    console.error(`[mcp:pool] ${errors.length} server(s) unavailable this turn: ${errors.join(" | ")}`);
  }

  return {
    tools,
    errors,
    // Release, not close: pooled clients persist across turns by design.
    async close() {},
  };
}

/**
 * Fire-and-forget pre-connect: start connecting `servers` in the background so
 * they are pooled BEFORE the first turn needs them. npx stdio servers
 * (filesystem/memory) cold-start >2.5s and would otherwise miss the first turn's
 * build deadline — warming them at startup means they're usually ready by the
 * first prompt. No deadline, no return; per-turn acquireMcpTools reuses whatever
 * has connected. Idempotent (cached entries are reused); a failed connect is
 * evicted by getOrConnect so a real turn retries.
 */
export function warmMcpClients(servers: McpServerConfig[]): void {
  for (const s of servers) {
    if (!s.enabled) continue;
    if (!validateMcpServerConfig(s).ok) continue;
    void getOrConnect(s).catch(() => {
      /* warm is best-effort — the eviction in getOrConnect lets a real turn retry */
    });
  }
}

/** Tear down every pooled client. Call on orchestrator/process shutdown. */
export async function closeAllMcpClients(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(
    entries.map(async (e) => {
      try {
        const cs = await e.promise;
        cs.cleanup?.();
        await cs.client.close().catch(() => {});
      } catch {
        /* a never-connected entry has nothing to close */
      }
    }),
  );
}

/** Test-only: reset pool state between cases. */
export function __resetMcpClientPoolForTests(): void {
  pool.clear();
}

/** Test-only: number of pooled (connecting or connected) entries. */
export function __mcpClientPoolSize(): number {
  return pool.size;
}
