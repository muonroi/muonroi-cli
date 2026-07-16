import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteTokensSpy = vi.fn(async (_provider: string) => {});
vi.mock("../auth/token-store.js", () => ({
  deleteTokens: (p: string) => deleteTokensSpy(p),
}));
vi.mock("../auth/registry.js", () => ({
  listOAuthProviderIds: async () => ["openai", "xai"],
}));

import { setKeyForProvider } from "../keychain.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "excl-"));
  process.env.MUONROI_ENV_FILE = join(dir, ".env");
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  deleteTokensSpy.mockClear();
});
afterEach(() => {
  delete process.env.MUONROI_ENV_FILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("auth exclusivity — setKeyForProvider clears OAuth", () => {
  it("logs out OAuth for an OAuth-capable provider when setting an API key", async () => {
    await setKeyForProvider("openai", "envkey-openai-abcdefghij");
    expect(process.env.OPENAI_API_KEY).toBe("envkey-openai-abcdefghij");
    expect(deleteTokensSpy).toHaveBeenCalledWith("openai");
  });

  it("does not touch OAuth for a non-OAuth provider", async () => {
    await setKeyForProvider("deepseek", "envkey-deepseek-abcdefg");
    expect(process.env.DEEPSEEK_API_KEY).toBe("envkey-deepseek-abcdefg");
    expect(deleteTokensSpy).not.toHaveBeenCalled();
  });
});
