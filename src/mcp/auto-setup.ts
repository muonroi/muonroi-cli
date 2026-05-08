import type { McpServerConfig } from "../utils/settings.js";
import { loadMcpServers, saveMcpServers } from "../utils/settings.js";

const DEFAULT_CONFIGS: McpServerConfig[] = [
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
    if (
      server.id === "figma" &&
      server.args?.includes("figma-developer-mcp") &&
      !server.args.includes("--stdio")
    ) {
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
    const toAdd = DEFAULT_CONFIGS.filter((s) => !existingIds.has(s.id));
    if (toAdd.length > 0) dirty = true;
    if (!dirty) return existing;
    const merged =
      toAdd.length > 0 ? [...toAdd, ...existing] : existing;
    saveMcpServers(merged);
    return merged;
  } catch {
    return [];
  }
}
