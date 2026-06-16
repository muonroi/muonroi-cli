import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpHome = path.join(os.tmpdir(), `muonroi-cli-auto-setup-${process.pid}`);

describe("ensureDefaultMcpServers — research servers", () => {
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it("registers context7 + fetch + tavily for a fresh user", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const ids = merged.map((s) => s.id);
    expect(ids).toContain("context7");
    expect(ids).toContain("fetch");
    expect(ids).toContain("tavily");
  });

  it("registers muonroi-docs as a default, enabled, http ecosystem source", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const docs = merged.find((s) => s.id === "muonroi-docs");
    expect(docs).toBeDefined();
    expect(docs?.enabled).toBe(true);
    expect(docs?.transport).toBe("http");
    expect(docs?.url).toContain("docs-mcp.muonroi.com");
  });

  it("does NOT register muonroi-tools (its tools are native in-process builtins now)", async () => {
    // The CLI no longer self-spawns itself as an MCP server. ee_query/ee_feedback/
    // ee_health/usage_forensics/lsp_query/setup_guide/selfverify_* are native
    // builtins (src/tools/native-tools.ts) — strictly better than a per-turn
    // subprocess cold-start. So muonroi-tools must NOT be seeded.
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    expect(merged.find((s) => s.id === "muonroi-tools")).toBeUndefined();
  });

  it("removes an existing self-spawned muonroi-tools entry (incl. an old vitest-worker-poisoned one)", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcp: {
          servers: [
            {
              id: "muonroi-tools",
              label: "muonroi-tools (Experience + Self-Diagnostics)",
              enabled: true,
              transport: "stdio",
              command: "C:\\Program Files\\nodejs\\node.exe",
              args: [
                "D:\\repo\\node_modules\\.bun\\vitest@4.1.5\\node_modules\\vitest\\dist\\workers\\forks.js",
                "tools-mcp",
              ],
            },
          ],
        },
      }),
    );
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    // Deprecated self-spawn stripped; no vitest worker path survives.
    expect(merged.find((s) => s.id === "muonroi-tools")).toBeUndefined();
    expect(JSON.stringify(merged)).not.toMatch(/vitest|forks\.js/);
  });

  it("removes a self-spawned muonroi-tools entry even with a valid bun-source command", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcp: {
          servers: [
            {
              id: "muonroi-tools",
              label: "muonroi-tools",
              enabled: true,
              transport: "stdio",
              command: "bun",
              args: ["/repo/src/index.ts", "tools-mcp"],
            },
            {
              id: "context7",
              label: "Context7",
              enabled: true,
              transport: "http",
              url: "https://mcp.context7.com/mcp",
            },
          ],
        },
      }),
    );
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    expect(merged.find((s) => s.id === "muonroi-tools")).toBeUndefined();
    // Unrelated user server preserved.
    expect(merged.find((s) => s.id === "context7")).toBeDefined();
  });

  it("context7 and fetch default to enabled", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const c7 = merged.find((s) => s.id === "context7");
    const fetchEntry = merged.find((s) => s.id === "fetch");
    expect(c7?.enabled).toBe(true);
    expect(fetchEntry?.enabled).toBe(true);
  });

  it("tavily defaults to disabled (key not yet provided)", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const tavily = merged.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(false);
  });

  it("does NOT overwrite an existing tavily entry already configured by user", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcp: {
          servers: [
            {
              id: "tavily",
              label: "Tavily Web Search",
              enabled: true,
              transport: "stdio",
              command: "npx",
              args: ["-y", "tavily-mcp"],
            },
          ],
        },
      }),
    );
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const tavily = merged.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(true); // user's setting preserved
  });

  it("is idempotent across repeated calls (no duplicate ids)", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const first = ensureDefaultMcpServers();
    const second = ensureDefaultMcpServers();
    expect(second.map((s) => s.id).sort()).toEqual(first.map((s) => s.id).sort());
    const ids = second.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
