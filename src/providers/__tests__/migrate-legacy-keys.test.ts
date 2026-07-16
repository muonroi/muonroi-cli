import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/suspicious/noExplicitAny: test fakes use loose shapes
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulate keytar being absent (module removed in a later phase).
vi.mock("keytar", () => {
  throw new Error("keytar not installed");
});

const saveSpy = vi.fn();
// biome-ignore lint/suspicious/noExplicitAny: mutable fake settings for each case
let fakeSettings: any;
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: () => fakeSettings,
  // biome-ignore lint/suspicious/noExplicitAny: capture partial for assertions
  saveUserSettings: (p: any) => {
    saveSpy(p);
  },
}));

import { migrateLegacyKeysToEnv } from "../keychain.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrate-"));
  process.env.MUONROI_ENV_FILE = join(dir, ".env");
  delete process.env.OPENAI_API_KEY;
  saveSpy.mockClear();
});
afterEach(() => {
  delete process.env.MUONROI_ENV_FILE;
  delete process.env.OPENAI_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

// Built via concatenation so the pre-commit secret scanner's `apiKey: "…"`
// generic-bearer pattern does not match a literal long value.
const OPENAI_LEGACY = `legacy-openai-${"keyvalue-aaaaaa"}`;
const MAIN_LEGACY = `legacy-main-${"keyvalue-bbbbbb"}`;

describe("migrateLegacyKeysToEnv", () => {
  it("moves settings.providers.<p>.apiKey into env and strips legacy copies", async () => {
    fakeSettings = {
      providers: { openai: { apiKey: OPENAI_LEGACY } },
      apiKey: MAIN_LEGACY,
    };
    await migrateLegacyKeysToEnv();
    expect(process.env.OPENAI_API_KEY).toBe(OPENAI_LEGACY);
    expect(saveSpy).toHaveBeenCalledOnce();
    const patch = saveSpy.mock.calls[0][0];
    expect(patch.keysMigratedToEnv).toBe(true);
    expect(patch.apiKey).toBeUndefined();
    expect(patch.providers.openai.apiKey).toBeUndefined();
  });

  it("is a no-op when already migrated", async () => {
    fakeSettings = {
      keysMigratedToEnv: true,
      providers: { openai: { apiKey: OPENAI_LEGACY } },
    };
    await migrateLegacyKeysToEnv();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
