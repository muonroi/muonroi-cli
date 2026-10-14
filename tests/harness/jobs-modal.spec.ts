/**
 * jobs-modal.spec.ts
 *
 * The `/jobs` view (`id="jobs-modal"`) lists every sub-agent and background job
 * of the session. The Agents rail shows only RUNNING work, so this view is the
 * one place finished jobs stay reachable — it must open from the slash menu,
 * own the keyboard while open, and close on Escape.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/jobs-modal.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("jobs modal E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("opens via /jobs, owns focus, and closes on Escape", async () => {
    // Type char by char so the slash-menu filter settles on "jobs" before Enter
    // (see subagents-modal.spec.ts for the burst race).
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    for (const ch of "jobs") driver.type(ch);
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    driver.press("Enter");

    await driver.wait_for({ selector: "id=jobs-modal", timeoutMs: 10_000 });
    const node = driver.query("id=jobs-modal");
    expect(node?.role).toBe("dialog");
    // A fresh session has spawned nothing yet.
    expect(node?.props?.count).toBe(0);
    expect(driver.query("focus")?.id).toBe("jobs-modal");

    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    expect(driver.query("id=jobs-modal")).toBeNull();
  });
});
