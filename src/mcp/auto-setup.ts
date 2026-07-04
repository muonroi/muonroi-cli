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

/**
 * Remove deprecated external MCP servers that are no longer seeded by default.
 *
 * - memory: superseded by native Experience Engine (ee_query + ee_write)
 * - playwright: heavy browser automation; native research tools (fetch_url/web_search) cover most needs. Can be added manually.
 * - figma: requires API key + specific workflow; removed from defaults. Can be added manually if needed.
 */
function removeDeprecatedExternalMcps(servers: McpServerConfig[]): boolean {
  const idsToRemove = new Set(["memory", "playwright", "figma"]);
  let removed = false;
  for (let i = servers.length - 1; i >= 0; i--) {
    if (idsToRemove.has(servers[i].id)) {
      servers.splice(i, 1);
      removed = true;
    }
  }
  if (removed) {
    console.error(
      "[mcp:auto-setup] removed deprecated external MCPs (memory/playwright/figma). Use native EE for memory; fetch_url + web_search for research. Add playwright/figma manually only if full integration required.",
    );
  }
  return removed;
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
    id: "context7",
    label: "Context7 (Library Docs)",
    enabled: true,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
  // fetch and tavily are now provided as *native* builtins (fetch_url / web_search).
  // The external MCP versions are kept in the catalog for users who explicitly want them,
  // but are no longer enabled by default for the inner agent.
  {
    id: "fetch",
    label: "Fetch (URL → markdown) [MCP legacy]",
    enabled: false,
    transport: "stdio",
    command: "bun",
    args: ["x", "-y", "mcp-fetch-server"],
  },
  {
    id: "tavily",
    label: "Tavily Web Search [MCP legacy]",
    enabled: false,
    transport: "stdio",
    command: "bun",
    args: ["x", "-y", "tavily-mcp"],
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

/**
 * Migrate any legacy "npx" stdio entries (from older default seeds or manual config)
 * to "bun x" form. npx shims frequently produce immediate "Connection closed"
 * under Bun on Windows; bun x gives clean stdio pipes. Idempotent.
 */
function migrateNpxToBunx(servers: McpServerConfig[]): boolean {
  let changed = false;
  for (const server of servers) {
    if (server.transport === "stdio" && server.command === "npx") {
      server.command = "bun";
      const rest = (server.args ?? []).filter((a) => a !== "-y");
      server.args = ["x", "-y", ...rest];
      changed = true;
    }
  }
  if (changed) {
    console.error(
      "[mcp:auto-setup] migrated legacy npx-based MCP servers to bun x (fixes Connection closed on Bun/Windows)",
    );
  }
  return changed;
}

export function ensureDefaultMcpServers(): McpServerConfig[] {
  try {
    const existing = loadMcpServers();
    let dirty = migrateServers(existing);

    // Upgrade legacy npx runners (most important fix for "Connection closed" during warm-up).
    if (migrateNpxToBunx(existing)) dirty = true;

    // Remove deprecated external MCPs (memory/playwright/figma) — replaced by native or manual opt-in.
    if (removeDeprecatedExternalMcps(existing)) dirty = true;

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
