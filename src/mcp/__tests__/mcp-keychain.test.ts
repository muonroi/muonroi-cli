import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("keytar", () => {
  const store = new Map<string, string>();
  return {
    getPassword: vi.fn(async (service: string, account: string) => store.get(`${service}:${account}`) ?? null),
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      store.set(`${service}:${account}`, password);
    }),
    deletePassword: vi.fn(async (service: string, account: string) => {
      return store.delete(`${service}:${account}`);
    }),
  };
});

import { deleteMcpKey, getMcpKey, setMcpKey } from "../mcp-keychain.js";

describe("mcp-keychain", () => {
  beforeEach(async () => {
    await deleteMcpKey("tavily");
    delete process.env.TAVILY_API_KEY;
  });

  it("stores and retrieves a tavily key", async () => {
    const ok = await setMcpKey("tavily", "tvly-1234567890abcdefghij");
    expect(ok).toBe(true);
    const got = await getMcpKey("tavily");
    expect(got).toBe("tvly-1234567890abcdefghij");
  });

  it("returns null when no key stored", async () => {
    const got = await getMcpKey("tavily");
    expect(got).toBeNull();
  });

  it("rejects keys shorter than 16 chars", async () => {
    await expect(setMcpKey("tavily", "short")).rejects.toThrow(/too short/i);
  });

  it("falls back to env var when keytar empty", async () => {
    process.env.TAVILY_API_KEY = "tvly-env-1234567890abcdefgh";
    const got = await getMcpKey("tavily");
    expect(got).toBe("tvly-env-1234567890abcdefgh");
    delete process.env.TAVILY_API_KEY;
  });
});
