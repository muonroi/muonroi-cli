import { basename, resolve } from "node:path";
import type { McpServerConfig } from "../utils/settings.js";
import { loadMcpServers, saveMcpServers } from "../utils/settings.js";

/**
 * True when running inside a test runner (vitest). Used to keep seed-time
 * persistence from mutating the user's REAL config — see ensureDefaultMcpServers.
 */
function isTestRunner(): boolean {
  return process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined || process.env.NODE_ENV === "test";
}

/**
 * Resolve how to re-invoke THIS CLI in `tools-mcp` mode for the self-spawned
 * muonroi-tools server. A compiled single-binary handles subcommands itself
 * (`<binary> tools-mcp`); running from source re-invokes the runtime on the
 * current entry script (`bun <entry> tools-mcp`). Absolute paths so the spawn
 * is cwd-independent.
 *
 * Returns null when no TRUSTWORTHY command can be derived from the current
 * process. This is critical: when running under a JS runtime, `process.argv[1]`
 * is NOT always the muonroi-cli entry — under a test/tooling runner it is a
 * vitest/tinypool worker script. Persisting `<runtime> <worker> tools-mcp`
 * spawns a process that crashes on launch ("Expected worker to be run in
 * node:child_process"), so the MCP handshake never completes and muonroi-tools
 * times out forever (live bug: a vitest fork-worker path got seeded into a
 * user's config). We only trust an `index.{ts,js,mjs,cjs}` entry; anything else
 * → null, and the caller skips/heals rather than write a crashing self-spawn.
 *
 * Escape hatch: MUONROI_TOOLS_MCP_COMMAND overrides the resolved command (args
 * are always ["tools-mcp"]) for non-standard layouts, packaging, and tests.
 */
function resolveToolsMcpCommand(): { command: string; args: string[] } | null {
  const override = process.env.MUONROI_TOOLS_MCP_COMMAND?.trim();
  if (override) return { command: override, args: ["tools-mcp"] };

  const exe = process.execPath;
  const base = basename(exe).toLowerCase();
  const isRuntime = base.startsWith("bun") || base.startsWith("node");
  if (!isRuntime) {
    // Compiled single-binary — it dispatches subcommands itself. Always trustworthy.
    return { command: exe, args: ["tools-mcp"] };
  }
  const entry = process.argv[1];
  if (!entry || !/^index\.(ts|js|mjs|cjs)$/.test(basename(entry).toLowerCase())) {
    return null;
  }
  return { command: exe, args: [resolve(entry), "tools-mcp"] };
}

/**
 * A muonroi-tools entry whose command/args would spawn something OTHER than this
 * CLI in tools-mcp mode — most importantly a test-runner worker (vitest/tinypool)
 * persisted by the older seed-time bug, which crashes on launch → permanent
 * timeout. Also flags an entry that doesn't actually pass the `tools-mcp`
 * subcommand. Detected so ensureDefaultMcpServers can self-heal it.
 */
function isBrokenToolsMcpEntry(s: McpServerConfig): boolean {
  if (s.id !== "muonroi-tools" || s.transport !== "stdio") return false;
  const joined = `${s.command ?? ""} ${(s.args ?? []).join(" ")}`.replace(/\\/g, "/").toLowerCase();
  if (/vitest|tinypool|\/workers\/(forks|threads|child)\.[cm]?js|\/\.vite/.test(joined)) return true;
  if (!(s.args ?? []).includes("tools-mcp")) return true;
  return false;
}

const DEFAULT_CONFIGS: McpServerConfig[] = [
  {
    // Authoritative source for the Muonroi ecosystem (BB/.NET template recipes,
    // package docs, setup_guide, docs_search). Shipped enabled by default so any
    // task touching the ecosystem always has a standard source to work from —
    // the CLI behaves like a senior who knows the ecosystem, not one guessing.
    id: "muonroi-docs",
    label: "muonroi-docs (Ecosystem Docs)",
    enabled: true,
    transport: "http",
    url: "https://docs-mcp.muonroi.com/mcp",
  },
  {
    id: "filesystem",
    label: "Filesystem",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    id: "playwright",
    label: "Playwright",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp"],
  },
  {
    id: "memory",
    label: "Memory",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "figma",
    label: "Figma",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    env: { FIGMA_API_KEY: "" },
  },
  {
    id: "context7",
    label: "Context7 (Library Docs)",
    enabled: true,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
  {
    id: "fetch",
    label: "Fetch (URL → markdown)",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-fetch-server"],
  },
  {
    id: "tavily",
    label: "Tavily Web Search",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "tavily-mcp"],
    env: { TAVILY_API_KEY: "" },
  },
];

const PACKAGE_MIGRATIONS: Record<string, string> = {
  "@anthropic-ai/figma-mcp": "figma-developer-mcp",
  "@anthropic-ai/mcp-playwright": "@playwright/mcp",
};

function migrateServers(servers: McpServerConfig[]): boolean {
  let changed = false;
  for (const server of servers) {
    const pkgArg = server.args?.find((a) => PACKAGE_MIGRATIONS[a]);
    if (pkgArg) {
      server.args = server.args!.map((a) => PACKAGE_MIGRATIONS[a] ?? a);
      changed = true;
    }
    if (server.id === "figma" && server.args?.includes("figma-developer-mcp") && !server.args.includes("--stdio")) {
      server.args = [...server.args, "--stdio"];
      changed = true;
    }
  }
  return changed;
}

export function ensureDefaultMcpServers(): McpServerConfig[] {
  try {
    const existing = loadMcpServers();
    let dirty = migrateServers(existing);

    // Self-heal a poisoned muonroi-tools entry. An older seed-time bug resolved
    // the self-spawn command from process.argv unconditionally; when that seed
    // ran inside a test-runner worker (vitest fork) it persisted a command that
    // spawns the worker — which crashes on launch, so muonroi-tools timed out on
    // every turn and looked "disconnected". Re-resolve it (or drop it when no
    // trustworthy command can be derived in this process) so it self-corrects.
    const toolsIdx = existing.findIndex((s) => s.id === "muonroi-tools");
    if (toolsIdx >= 0 && isBrokenToolsMcpEntry(existing[toolsIdx]!)) {
      const fixed = resolveToolsMcpCommand();
      if (fixed) {
        existing[toolsIdx] = { ...existing[toolsIdx]!, command: fixed.command, args: fixed.args };
      } else {
        // Can't trust the current process to name the self-spawn (e.g. we ARE a
        // test runner). Drop the broken entry; a real run re-seeds it cleanly
        // rather than leave a crashing self-spawn in place.
        existing.splice(toolsIdx, 1);
      }
      dirty = true;
    }

    const existingIds = new Set(existing.map((s) => s.id));
    // muonroi-tools is THIS CLI self-spawned (`<self> tools-mcp`): the agent's
    // experience loop (ee_query/ee_feedback/ee_health) + self-diagnostics
    // (usage_forensics, lsp_query, selfverify_*, setup_guide). Enabled by default
    // so the agent can record/recall experience + feedback, prioritised after
    // errors. Only seeded when a TRUSTWORTHY self-spawn command can be resolved —
    // never a guess that would crash on launch.
    const toolsMcp = resolveToolsMcpCommand();
    const defaults: McpServerConfig[] = [...DEFAULT_CONFIGS];
    if (toolsMcp) {
      defaults.push({
        id: "muonroi-tools",
        label: "muonroi-tools (Experience + Self-Diagnostics)",
        enabled: true,
        transport: "stdio",
        command: toolsMcp.command,
        args: toolsMcp.args,
      });
    }
    const toAdd = defaults.filter((s) => !existingIds.has(s.id));
    if (toAdd.length > 0) dirty = true;
    if (!dirty) return existing;
    const merged = toAdd.length > 0 ? [...toAdd, ...existing] : existing;
    // Never let a test runner mutate the user's REAL config file. Tests assert on
    // the returned array; persistence is exercised only on real runs. This closes
    // the leak that wrote the vitest-worker command into a live config (the seed
    // runs in the Orchestrator constructor, which orchestrator tests trigger).
    if (!isTestRunner()) saveMcpServers(merged);
    return merged;
  } catch (err) {
    console.error(`[mcp:auto-setup] ensureDefaultMcpServers failed: ${(err as Error)?.message}`, {
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    return [];
  }
}
