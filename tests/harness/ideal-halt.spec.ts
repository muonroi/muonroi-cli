/**
 * ideal-halt.spec.ts — E2E harness spec for the halt recovery card (Task 5.2).
 *
 * Uses --inject-halt to dispatch a synthetic halt chunk after boot, bypassing
 * the need to trigger a real CB-3 sprint run inside the test. The seam is
 * documented in src/ui/app.tsx (AppStartupConfig.injectHalt) and
 * src/index.ts (--inject-halt CLI flag).
 *
 * Test trigger mechanism: --inject-halt flag (synthetic seam, not real CB-3).
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("ideal halt recovery card E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash", "--inject-halt"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // Wait for TUI to be idle (synthetic halt card is rendered immediately on mount).
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before the halt card
    // mounts. Wait for it explicitly so subsequent tests can query it.
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("halt recovery card is present with correct role and isModal", async () => {
    // The card should already be visible after the first idle — no user action needed.
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
    const card = driver.query("id=ideal-halt-card");
    expect(card).not.toBeNull();
    expect(card?.role).toBe("dialog");
    expect(card?.isModal).toBe(true);
  });

  it("card name is 'Recovery options'", () => {
    const card = driver.query("id=ideal-halt-card");
    expect(card?.name).toBe("Recovery options");
  });

  it("card contains exactly 3 option listitems", () => {
    // Options are wrapped in <Semantic role="listitem"> inside the dialog.
    const options = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(options).toHaveLength(3);
  });

  it("first option is init_new with correct label", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    // Option labels are set as the Semantic name prop.
    expect(opts[0]?.name).toBe("Init new project");
  });

  it("second option is point_to_existing", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[1]?.name).toBe("Point to existing recipe");
  });

  it("third option is continue_as_council", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[2]?.name).toBe("Continue as council brainstorm");
  });

  it("first option is selected by default", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[0]?.selected).toBe(true);
    expect(opts[1]?.selected).toBeFalsy();
    expect(opts[2]?.selected).toBeFalsy();
  });

  it("Down arrow moves selection to second option", async () => {
    driver.press("Down");
    // Wait for the snapshot to reflect the new selected state. Using a
    // selector with the `selected` flag is more reliable than polling
    // wait_for({idle}) — the latter resolves on the first idle event and
    // can miss the window between React's batched state commit and the
    // 16ms setInterval reconciler tick.
    await driver.wait_for({
      selector: "id=halt-option-point_to_existing selected",
      timeoutMs: 10_000,
    });
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[0]?.selected).toBeFalsy();
    expect(opts[1]?.selected).toBe(true);
  });

  it("Escape dismisses the halt card", async () => {
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    // After dismiss, the card should no longer appear in the frame.
    const card = driver.query("id=ideal-halt-card");
    expect(card).toBeNull();
  });
});
