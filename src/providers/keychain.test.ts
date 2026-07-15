/**
 * Tests for src/providers/keychain.ts
 * Mocks keytar and env vars to verify loadKeyForProvider + firstAvailableProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We'll mock keytar at the module level
vi.mock("keytar", () => ({
  getPassword: vi.fn().mockResolvedValue(null),
}));

// Mock settings so the settings.json providers fallback doesn't interfere
vi.mock("../utils/settings.js", () => ({
  loadUserSettings: () => ({ providers: {} }),
}));

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteKeyForProvider,
  firstAvailableProvider,
  loadKeyForProvider,
  ProviderKeyMissingError,
  setKeyForProvider,
} from "./keychain.js";

describe("setKeyForProvider / deleteKeyForProvider (env-store)", () => {
  beforeEach(() => {
    process.env.MUONROI_ENV_FILE = join(tmpdir(), `kc-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    delete process.env.MUONROI_ENV_FILE;
    delete process.env.OPENAI_API_KEY;
  });

  it("writes env; loads it back; delete clears", async () => {
    await setKeyForProvider("openai", "sk-openai-abcdefghijklmnop");
    expect(process.env.OPENAI_API_KEY).toBe("sk-openai-abcdefghijklmnop");
    expect(await loadKeyForProvider("openai")).toBe("sk-openai-abcdefghijklmnop");
    const had = await deleteKeyForProvider("openai");
    expect(had).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("loadKeyForProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    // Restore
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("returns key from env var when keytar returns null", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-key-longer-than-20-chars";
    const key = await loadKeyForProvider("openai");
    expect(key).toBe("sk-test-openai-key-longer-than-20-chars");
  });

  it("throws ProviderKeyMissingError when no key found for non-ollama provider", async () => {
    await expect(loadKeyForProvider("openai")).rejects.toThrow(ProviderKeyMissingError);
  });

  it("returns empty string for ollama when no key set (keyless)", async () => {
    const key = await loadKeyForProvider("ollama");
    expect(key).toBe("");
  });

  it("reads from ANTHROPIC_API_KEY env var", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-long-enough-for-validation";
    const key = await loadKeyForProvider("anthropic");
    expect(key).toBe("sk-ant-test-key-long-enough-for-validation");
  });

  it("reads from DEEPSEEK_API_KEY env var", async () => {
    const fake = "deepseek-mock-key-longer-than-twenty";
    process.env.DEEPSEEK_API_KEY = fake;
    const key = await loadKeyForProvider("deepseek");
    expect(key).toBe(fake);
  });
});

describe("firstAvailableProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("returns anthropic when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-long-enough-for-validation";
    const p = await firstAvailableProvider();
    expect(p).toBe("anthropic");
  });

  it("returns openai when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-key-longer-than-20-chars";
    const p = await firstAvailableProvider();
    expect(p).toBe("openai");
  });

  it("returns ollama as fallback (keyless)", async () => {
    // No keys set — ollama is keyless so it should be found
    const p = await firstAvailableProvider();
    expect(p).toBe("ollama");
  });
});
