import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("composer E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // -k FAKE + explicit -m bypass the first-run API-key modal on fresh clones
    // (e.g., CI runners without a keychain). Mock-LLM intercepts before the key
    // is ever validated against a real provider.
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    // Wait for the textbox before querying.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("composer is focused on startup", () => {
    expect(driver.query("focus")?.role).toBe("textbox");
  });

  it("type op reaches the TUI (input bridge wired)", async () => {
    driver.type("hello world");
    // Bridge translates each char → keyHandler.emit("keypress"). After typing
    // 11 chars, the next idle window should re-fire.
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it("Enter press dispatches and log appears", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    expect(driver.query("role=log")?.role).toBe("log");
  });
});
