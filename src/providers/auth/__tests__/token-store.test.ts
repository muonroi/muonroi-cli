/**
 * Tests for src/providers/auth/token-store.ts
 *
 * Tests keychain-primary path with a mock keytar, and the file-fallback path
 * when keytar is unavailable.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthTokens } from "../types.js";

// Token-store uses process.env.MUONROI_AUTH_DIR for test overrides.
// (vi.spyOn(os, "homedir") fails in ESM — non-configurable export.)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// NOTE: token values kept < 16 chars to avoid triggering the pre-commit
// secret scanner's generic-bearer pattern: /token\s*:\s*['"][^'"]{16,}['"]/
const SAMPLE_TOKENS: OAuthTokens = {
  accessToken: "acc-tok-fixture",
  refreshToken: "ref-tok-fixture",
  idToken: "id-tok-fixt",
  accountId: "acc_123",
  expiresAt: Date.now() + 3600_000,
  email: "user@example.com",
};

// ---------------------------------------------------------------------------
// Mock keytar store
// ---------------------------------------------------------------------------

function makeKeytarMock() {
  const store = new Map<string, string>();
  return {
    getPassword: vi.fn(async (_svc: string, account: string) => store.get(account) ?? null),
    setPassword: vi.fn(async (_svc: string, account: string, password: string) => {
      store.set(account, password);
    }),
    deletePassword: vi.fn(async (_svc: string, account: string) => {
      if (store.has(account)) {
        store.delete(account);
        return true;
      }
      return false;
    }),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Tests: keychain path
// ---------------------------------------------------------------------------

describe("token-store — keychain path", () => {
  it("saves and loads tokens via keychain", async () => {
    const kt = makeKeytarMock();
    // Inject mock keytar via module mock
    vi.doMock("keytar", () => kt);

    const { saveTokens, loadTokens, deleteTokens } = await import("../token-store.js");

    await saveTokens("openai", SAMPLE_TOKENS);
    expect(kt.setPassword).toHaveBeenCalledOnce();

    const loaded = await loadTokens("openai");
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe(SAMPLE_TOKENS.accessToken);
    expect(loaded!.email).toBe("user@example.com");

    await deleteTokens("openai");
    expect(kt.deletePassword).toHaveBeenCalledOnce();

    vi.doUnmock("keytar");
  });
});

// ---------------------------------------------------------------------------
// Tests: file fallback path
// ---------------------------------------------------------------------------

describe("token-store — file fallback", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `muonroi-test-token-store-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    // Override auth dir via env var (token-store reads MUONROI_AUTH_DIR)
    process.env["MUONROI_AUTH_DIR"] = tempDir;
  });

  afterEach(async () => {
    delete process.env["MUONROI_AUTH_DIR"];
    await rm(tempDir, { recursive: true, force: true });
  });

  it("saves tokens to file when keytar unavailable", async () => {
    // Make keytar unavailable
    vi.doMock("keytar", () => {
      throw new Error("keytar not available");
    });

    const { saveTokens, loadTokens } = await import("../token-store.js");

    await saveTokens("openai", SAMPLE_TOKENS);

    const filePath = path.join(tempDir, "openai.json");
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OAuthTokens;
    expect(parsed.accessToken).toBe(SAMPLE_TOKENS.accessToken);

    const loaded = await loadTokens("openai");
    expect(loaded).not.toBeNull();
    expect(loaded!.refreshToken).toBe(SAMPLE_TOKENS.refreshToken);

    vi.doUnmock("keytar");
  });
});

// ---------------------------------------------------------------------------
// Tests: deleteTokens when nothing stored
// ---------------------------------------------------------------------------

describe("token-store — deleteTokens no-op", () => {
  it("does not throw when nothing is stored", async () => {
    // Point at a non-existent dir so file fallback also has nothing
    process.env["MUONROI_AUTH_DIR"] = path.join(os.tmpdir(), `muonroi-nonexistent-${Date.now()}`);

    vi.doMock("keytar", () => ({
      getPassword: vi.fn(async () => null),
      setPassword: vi.fn(async () => {}),
      deletePassword: vi.fn(async () => false),
    }));

    const { deleteTokens } = await import("../token-store.js");
    await expect(deleteTokens("openai")).resolves.not.toThrow();

    delete process.env["MUONROI_AUTH_DIR"];
    vi.doUnmock("keytar");
  });
});
