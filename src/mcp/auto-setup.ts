import { basename, resolve } from "node:path";
import type { McpServerConfig } from "../utils/settings.js";
import { loadMcpServers, saveMcpServers } from "../utils/settings.js";

/**
 * Resolve how to re-invoke THIS CLI in `tools-mcp` mode for the self-spawned
 * muonroi-tools server. A compiled single-binary handles subcommands itself
 * (`<binary> tools-mcp`); running from source re-invokes the runtime on the
 * current entry script (`bun <entry> tools-mcp`). Absolute paths so the spawn
 * is cwd-independent. If the resolved command is wrong on another machine, the
 * resilient MCP build just reports the server unavailable (never crashes).
 */
function resolveToolsMcpCommand(): { command: string; args: string[] } {
  const exe = process.execPath;
  const base = basename(exe).toLowerCase();
  const isRuntime = base.startsWith("bun") || base.startsWith("node");
  const entry = process.argv[1];
  if (isRuntime && entry) {
    return { command: exe, args: [resolve(entry), "tools-mcp"] };
  }
  return { command: exe, args: ["tools-mcp"] };
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
    const existingIds = new Set(existing.map((s) => s.id));
    // muonroi-tools is THIS CLI self-spawned (`<self> tools-mcp`): the agent's
    // experience loop (ee_query/ee_feedback/ee_health) + self-diagnostics
    // (usage_forensics, lsp_query, selfverify_*, setup_guide). Command resolved
    // at seed time to the current runtime. Enabled by default so the agent can
    // record/recall experience + feedback, prioritised especially after errors.
    const toolsMcp = resolveToolsMcpCommand();
    const defaults: McpServerConfig[] = [
      ...DEFAULT_CONFIGS,
      {
        id: "muonroi-tools",
        label: "muonroi-tools (Experience + Self-Diagnostics)",
        enabled: true,
        transport: "stdio",
        command: toolsMcp.command,
        args: toolsMcp.args,
      },
    ];
    const toAdd = defaults.filter((s) => !existingIds.has(s.id));
    if (toAdd.length > 0) dirty = true;
    if (!dirty) return existing;
    const merged = toAdd.length > 0 ? [...toAdd, ...existing] : existing;
    saveMcpServers(merged);
    return merged;
  } catch {
    return [];
  }
}
