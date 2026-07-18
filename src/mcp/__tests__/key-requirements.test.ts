import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    keychainKey = null;
    resetNeedsKeyNotice();
    vi.restoreAllMocks();
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
