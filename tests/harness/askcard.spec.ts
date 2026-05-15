import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("askcard E2E", () => {
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

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("composer accepts input on startup", () => {
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it.skip("council question modal appears and is observable", async () => {
    // requires mock-llm sequence mode (Phase B) to drive council orchestrator to emit a `council_question` chunk
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    expect(driver.query("id=askcard")?.role).toBe("dialog");
  });

  it.skip("can navigate askcard options with arrow keys", async () => {
    // requires mock-llm sequence mode (Phase B) to drive council orchestrator to emit a `council_question` chunk
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    driver.press("Down");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const selected = driver.queryAll("role=button").find((n) => n.selected);
    expect(selected).toBeDefined();
  });
});
