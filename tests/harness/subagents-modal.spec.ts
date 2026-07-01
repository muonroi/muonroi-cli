/**
 * subagents-modal.spec.ts
 *
 * Verifies that the Subagents browser modal (`id="subagents-modal"`) is
 * reachable via the `/agents` slash command and is observable by the harness.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/subagents-modal.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("subagents modal E2E", () => {
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

  it("subagents modal opens via /agents slash command", async () => {
    // Type "/" first and wait for the slash menu to open.  The slash menu
    // filters items as characters arrive; if we send "/agents\n" as a single
    // burst the Enter fires before React re-renders with the filtered list,
    // so the default-selected item (index 0 = "exit") wins instead of "agents".
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    driver.type("a");
    driver.type("g");
    driver.type("e");
    driver.type("n");
    driver.type("t");
    driver.type("s");
    // Wait for the filter to settle so filteredSlashItems[0] === "agents".
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    driver.press("Enter");
    await driver.wait_for({ selector: "id=subagents-modal", timeoutMs: 10_000 });
    const node = driver.query("id=subagents-modal");
    expect(node?.role).toBe("dialog");
  });
});
