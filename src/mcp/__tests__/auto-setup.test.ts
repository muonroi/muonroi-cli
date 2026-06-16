import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpHome = path.join(os.tmpdir(), `muonroi-cli-auto-setup-${process.pid}`);
// A trustworthy self-spawn command injected via the override env. Without it,
// resolveToolsMcpCommand() correctly returns null under vitest (argv[1] is a
// vitest worker, NOT the CLI entry) — which is the whole point of the fix:
// a test must never derive (and persist) the worker command.
const FAKE_CLI = path.join(os.tmpdir(), "muonroi-cli-fake");

describe("ensureDefaultMcpServers — research servers", () => {
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origToolsCmd: string | undefined;

  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    origToolsCmd = process.env.MUONROI_TOOLS_MCP_COMMAND;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.MUONROI_TOOLS_MCP_COMMAND = FAKE_CLI;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (origToolsCmd === undefined) delete process.env.MUONROI_TOOLS_MCP_COMMAND;
    else process.env.MUONROI_TOOLS_MCP_COMMAND = origToolsCmd;
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

  it("registers muonroi-tools as a default self-spawned stdio server (tools-mcp)", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const tools = merged.find((s) => s.id === "muonroi-tools");
    expect(tools).toBeDefined();
    expect(tools?.enabled).toBe(true);
    expect(tools?.transport).toBe("stdio");
    // Re-invokes THIS CLI in tools-mcp mode (command = resolved runtime/override, args end with the subcommand).
    expect(tools?.args?.at(-1)).toBe("tools-mcp");
    expect(tools?.command).toBe(FAKE_CLI);
  });

  it("does NOT derive a self-spawn command from a test-runner argv (returns no muonroi-tools)", async () => {
    // The root cause of the live bug: under vitest, process.argv[1] is a fork
    // worker, NOT the CLI entry. Without the override, resolveToolsMcpCommand
    // must REFUSE (return null) rather than persist `<node> <worker> tools-mcp`,
    // which crashes on spawn → permanent timeout. So muonroi-tools is simply not
    // registered in this (untrustworthy) process.
    delete process.env.MUONROI_TOOLS_MCP_COMMAND;
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    expect(merged.find((s) => s.id === "muonroi-tools")).toBeUndefined();
  });

  it("self-heals a poisoned muonroi-tools entry that points at a vitest worker", async () => {
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
    const tools = merged.find((s) => s.id === "muonroi-tools");
    expect(tools).toBeDefined();
    // Healed to the trustworthy override; no vitest worker path survives.
    expect(tools?.command).toBe(FAKE_CLI);
    expect(tools?.args).toEqual(["tools-mcp"]);
    expect(JSON.stringify(tools)).not.toMatch(/vitest|forks\.js/);
  });

  it("drops a poisoned muonroi-tools entry when no trustworthy command can be resolved", async () => {
    delete process.env.MUONROI_TOOLS_MCP_COMMAND; // force resolveToolsMcpCommand → null under vitest
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
              command: "node",
              args: ["/x/vitest/dist/workers/forks.js", "tools-mcp"],
            },
          ],
        },
      }),
    );
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    // Broken entry removed rather than left in place (re-seeds cleanly on a real run).
    expect(merged.find((s) => s.id === "muonroi-tools")).toBeUndefined();
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
