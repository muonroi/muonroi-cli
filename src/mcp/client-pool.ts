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
 * later is evicted when one of its tool calls hits a transport/connection error,
 * so the next turn reconnects fresh.
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

/** Tear down one pooled entry (best-effort) and remove it. */
function evict(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  void entry.promise.then(
    (cs) => {
      cs.cleanup?.();
      void cs.client.close().catch(() => {});
    },
    () => {},
  );
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
  // Cache a rejection only transiently: evict so the next turn retries rather
  // than returning the same failed promise forever.
  promise.catch(() => {
    if (pool.get(key) === entry) pool.delete(key);
  });
  return promise;
}

/**
 * Wrap each tool's execute so a transport/connection failure evicts the pooled
 * client (next turn reconnects). The MCP child may die after a successful
 * connect; without this the dead client would be reused on every later turn.
 */
function wrapForSelfHeal(tools: ToolSet, key: string): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
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
          if (isConnectionError(e)) {
            console.error(
              `[mcp:pool] '${name}' hit a connection error — evicting cached client so the next turn reconnects`,
            );
            evict(key);
          }
          throw e;
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

  for (const slot of slots) {
    if (slot.done) {
      if (slot.error) {
        errors.push(`${slot.label}: ${slot.error}`);
      } else if (slot.result) {
        Object.assign(tools, wrapForSelfHeal(slot.result.tools, slot.key));
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
