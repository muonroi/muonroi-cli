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
 * Remove a deprecated self-spawned `muonroi-tools` stdio server from the config.
 *
 * The CLI's OWN inner agent now exposes ee_query/ee_feedback/ee_health/
 * usage_forensics/lsp_query/setup_guide/selfverify_* as NATIVE in-process
 * builtins (src/tools/native-tools.ts) — strictly better than self-spawning a
 * 137MB CLI as an MCP subprocess (which cold-started 2-3.5s, overran the build
 * deadline, and once had a vitest-worker command persisted that crashed on
 * launch). So the self-spawn is now pure waste: every tool it would expose is
 * dropped as a native twin. Strip it on sight. The muonroi-tools MCP server
 * still exists for EXTERNAL agents via their own config (e.g. ~/.claude.json) —
 * that is a different file and is untouched here. Returns true if it changed.
 */
function removeDeprecatedToolsMcp(servers: McpServerConfig[]): boolean {
  const idx = servers.findIndex((s) => s.id === "muonroi-tools" && s.transport === "stdio");
  if (idx < 0) return false;
  servers.splice(idx, 1);
  console.error(
    "[mcp:auto-setup] removed deprecated self-spawned muonroi-tools server — its tools are now native in-process builtins",
  );
  return true;
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

    // muonroi-tools is no longer self-spawned by the CLI — its capabilities
    // (ee_query/ee_feedback/ee_health/usage_forensics/lsp_query/setup_guide/
    // selfverify_*) are NATIVE in-process builtins now (src/tools/native-tools.ts).
    // Strip any deprecated self-spawn entry so it stops cold-starting a redundant
    // subprocess every turn (and removes the old vitest-worker-poisoned ones).
    if (removeDeprecatedToolsMcp(existing)) dirty = true;

    const existingIds = new Set(existing.map((s) => s.id));
    const toAdd = DEFAULT_CONFIGS.filter((s) => !existingIds.has(s.id));
    if (toAdd.length > 0) dirty = true;
    if (!dirty) return existing;
    const merged = toAdd.length > 0 ? [...toAdd, ...existing] : existing;
    // Never let a test runner mutate the user's REAL config file. Tests assert on
    // the returned array; persistence is exercised only on real runs. This closes
    // the leak whereby the seed (run from the Orchestrator constructor, which
    // orchestrator tests trigger) wrote into a live config.
    if (!isTestRunner()) saveMcpServers(merged);
    return merged;
  } catch (err) {
    console.error(`[mcp:auto-setup] ensureDefaultMcpServers failed: ${(err as Error)?.message}`, {
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    return [];
  }
}
