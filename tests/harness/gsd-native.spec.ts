import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("gsd-native E2E smoke", () => {
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let greenfield: string;

  beforeAll(async () => {
    greenfield = mkdtempSync(join(tmpdir(), "gsd-harness-"));
    ctx = await spawnHarness({
      cwd: greenfield,
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: {
        MUONROI_GSD_NATIVE: "1",
        MUONROI_TEST_NO_KEYCHAIN: "1",
      },
      idleTimeoutMs: 20_000,
    });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 20_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.cleanup();
    if (greenfield) {
      try {
        rmSync(greenfield, { recursive: true, force: true });
      } catch {
        /* best-effort — EBUSY on Windows when child handles linger */
      }
    }
  });

  it("boots agent-mode TUI with MUONROI_GSD_NATIVE=1", async () => {
    const composer = ctx.driver.query("id=composer");
    expect(composer?.role).toBe("textbox");
    const status = ctx.driver.query("id=status");
    expect(status?.role).toBe("statusbar");
  });
});
