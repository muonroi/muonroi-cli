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
    fs.rmSync(tmpHome, { recursive: true, force: true });
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
