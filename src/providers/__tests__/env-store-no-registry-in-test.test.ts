import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { clearEnvVar, persistEnvVar } from "../env-store.js";

/**
 * `bunx vitest run` on Windows wrote the developer's real OS-global
 * environment. HKCU:\Environment was left holding the fixture values from
 * env-store.test.ts (TEST_KEY_A / TEST_KEY_B), migrate-legacy-keys.test.ts and
 * auth-exclusivity.test.ts (both credential-shaped).
 *
 * Those tests point MUONROI_ENV_FILE at a temp dir and remove it, so they look
 * hermetic — but persistEnvVar also mirrors to the registry, none of them mocks
 * child_process, and nothing cleaned it. The credential fixtures outlived the
 * suite and shadowed the real provider credentials for every new process:
 * sub-agents 401'd, the AI SDK turned the resulting empty stream into
 * AI_NoOutputGeneratedError, and /ideal's implementation stage died in 0.6s
 * across three runs — the bug filed as "G1" and blamed on reasoning models.
 *
 * The guard lives in the mirror itself, not in per-test mocks, because the next
 * test to call persistEnvVar would reintroduce the leak.
 */
describe("mirrorToWindowsRegistry — never under a test runner", () => {
  const mocked = vi.mocked(execFileSync);
  let realPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    process.env.MUONROI_ENV_FILE = join(mkdtempSync(join(tmpdir(), "no-reg-")), ".env");
    mocked.mockClear();
    // Force the win32 branch so this asserts on every CI platform, not just
    // Windows — a POSIX-only run would pass vacuously.
    realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    delete process.env.MUONROI_ENV_FILE;
    delete process.env.TEST_ONLY_KEY;
  });

  it("does not shell out to powershell when persisting under vitest", () => {
    persistEnvVar("TEST_ONLY_KEY", "fixture-value-1234567890");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("does not shell out to powershell when clearing under vitest", () => {
    clearEnvVar("TEST_ONLY_KEY");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("still does its real job: the value reaches process.env and the store", () => {
    persistEnvVar("TEST_ONLY_KEY", "fixture-value-1234567890");
    // Suppressing the mirror must not suppress the write the caller asked for.
    expect(process.env.TEST_ONLY_KEY).toBe("fixture-value-1234567890");
  });

  it("mirrors again once the test-runner markers are gone", () => {
    const vitest = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      persistEnvVar("TEST_ONLY_KEY", "fixture-value-1234567890");
      // Proves the guard is the test-runner check, not a blanket disable.
      expect(mocked).toHaveBeenCalledOnce();
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
      if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
    }
  });
});
