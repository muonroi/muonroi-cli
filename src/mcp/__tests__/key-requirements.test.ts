import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../utils/settings.js";

// Keychain returns whatever the test sets; default = no stored key.
let keychainKey: string | null = null;
vi.mock("../mcp-keychain.js", () => ({
  getMcpKey: vi.fn(async () => keychainKey),
}));

import {
  noticeNeedsKeyOnce,
  partitionEnabledServers,
  resetNeedsKeyNotice,
  resolveMissingKey,
} from "../key-requirements.js";

function srv(over: Partial<McpServerConfig>): McpServerConfig {
  return { id: "x", label: "X", enabled: true, transport: "stdio", ...over } as McpServerConfig;
}

describe("key-requirements (① self-heal / ③ fallback)", () => {
  const savedTavilyEnv = process.env.TAVILY_API_KEY;
  beforeEach(() => {
    keychainKey = null;
    // Deterministic: the native-fallback availability check reads this env var.
    delete process.env.TAVILY_API_KEY;
    resetNeedsKeyNotice();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (savedTavilyEnv === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedTavilyEnv;
  });

  it("resolveMissingKey flags tavily when no env and no keychain key", async () => {
    const missing = await resolveMissingKey(srv({ id: "tavily", label: "Tavily" }));
    expect(missing?.id).toBe("tavily");
    expect(missing?.envVar).toBe("TAVILY_API_KEY");
    expect(missing?.nativeFallback).toBe("web_search");
  });

  it("resolveMissingKey returns null when an inline env key is present", async () => {
    const s = srv({ id: "tavily", env: { TAVILY_API_KEY: "tvly-1234567890abcd" } });
    expect(await resolveMissingKey(s)).toBeNull();
  });

  it("resolveMissingKey returns null when the keychain has the key", async () => {
    keychainKey = "tvly-keychain-1234567890";
    expect(await resolveMissingKey(srv({ id: "tavily" }))).toBeNull();
  });

  it("resolveMissingKey ignores a too-short key (placeholder/blank)", async () => {
    const s = srv({ id: "tavily", env: { TAVILY_API_KEY: "short" } });
    expect((await resolveMissingKey(s))?.id).toBe("tavily");
  });

  it("resolveMissingKey returns null for a server with no key requirement", async () => {
    expect(await resolveMissingKey(srv({ id: "filesystem" }))).toBeNull();
  });

  it("nativeFallbackAvailable is false when the fallback's key is not in the process env", async () => {
    // Card shows (no env/keychain key) AND web_search would also error → the
    // built-in does NOT cover the capability.
    const missing = await resolveMissingKey(srv({ id: "tavily", label: "Tavily" }));
    expect(missing?.nativeFallback).toBe("web_search");
    expect(missing?.nativeFallbackAvailable).toBe(false);
  });

  it("nativeFallbackAvailable is true when the process env holds a usable key", async () => {
    // The Tavily MCP server can still be unconfigured (empty server.env
    // overrides the inherited env at spawn) while native web_search reads the
    // process env directly and works.
    process.env.TAVILY_API_KEY = ["test", "tavily", "process", "env", "key", "1234567890"].join("-");
    const missing = await resolveMissingKey(srv({ id: "tavily", label: "Tavily", env: { TAVILY_API_KEY: "" } }));
    expect(missing?.id).toBe("tavily");
    expect(missing?.nativeFallbackAvailable).toBe(true);
  });

  it("noticeNeedsKeyOnce advertises the built-in only when it actually works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Not reachable → no "Using the built-in" claim.
    const { needsKey } = await partitionEnabledServers([srv({ id: "tavily", label: "Tavily" })]);
    noticeNeedsKeyOnce(needsKey);
    expect(warn.mock.calls[0]?.[0]).not.toContain("Using the built-in");

    // Reachable → advertise it.
    resetNeedsKeyNotice();
    warn.mockClear();
    process.env.TAVILY_API_KEY = ["test", "tavily", "process", "env", "key", "1234567890"].join("-");
    const ready = await partitionEnabledServers([srv({ id: "tavily", label: "Tavily", env: { TAVILY_API_KEY: "" } })]);
    noticeNeedsKeyOnce(ready.needsKey);
    expect(warn.mock.calls[0]?.[0]).toContain("Using the built-in web_search");
  });

  it("partitionEnabledServers excludes keyless-required servers from connectable, not disabled ones", async () => {
    const { connectable, needsKey } = await partitionEnabledServers([
      srv({ id: "filesystem", label: "FS", enabled: true }),
      srv({ id: "tavily", label: "Tavily", enabled: true }), // keyless → needsKey
      srv({ id: "memory", label: "Mem", enabled: false }), // disabled → dropped entirely
    ]);
    expect(connectable.map((s) => s.id)).toEqual(["filesystem"]);
    expect(needsKey.map((s) => s.id)).toEqual(["tavily"]);
  });

  it("noticeNeedsKeyOnce announces a server only once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { needsKey } = await partitionEnabledServers([srv({ id: "tavily", label: "Tavily" })]);
    expect(noticeNeedsKeyOnce(needsKey).map((s) => s.id)).toEqual(["tavily"]); // first: announced
    expect(noticeNeedsKeyOnce(needsKey)).toEqual([]); // second: already noticed → silent
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
