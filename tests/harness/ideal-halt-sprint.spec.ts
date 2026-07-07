/**
 * ideal-halt-sprint.spec.ts — E2E harness spec for the sprint-break recovery
 * card (A). Uses --inject-halt-sprint to render a synthetic `sprint_failed` halt
 * chunk after boot, bypassing the need to trigger a real mid-run failure.
 *
 * The card offers Resume / Retry / Skip verify / Abort — all of which re-dispatch
 * through `/ideal resume|abort` with runId auto-detected (A/B). This spec only
 * verifies the card renders with the right structure + navigation; the resume/
 * abort wiring is covered by unit tests (product-loop integration + ideal slash).
 *
 * Test trigger mechanism: --inject-halt-sprint flag (synthetic seam).
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("ideal sprint-failed recovery card E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--inject-halt-sprint"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("renders the recovery card as a modal dialog", async () => {
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
    const card = driver.query("id=ideal-halt-card");
    expect(card).not.toBeNull();
    expect(card?.role).toBe("dialog");
    expect(card?.isModal).toBe(true);
  });

  it("offers exactly 4 recovery options", () => {
    const options = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(options).toHaveLength(4);
  });

  it("options are Resume / Retry / Skip verify / Abort in order", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[0]?.name).toBe("Resume");
    expect(opts[1]?.name).toBe("Retry sprint");
    expect(opts[2]?.name).toBe("Skip verify & resume");
    expect(opts[3]?.name).toBe("Abort run");
  });

  it("Resume is selected by default", () => {
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts[0]?.selected).toBe(true);
    expect(opts[1]?.selected).toBeFalsy();
  });

  it("Down arrow advances the selection", async () => {
    driver.press("Down");
    let stable = 0;
    const deadline = Date.now() + 10_000;
    let opts: ReturnType<typeof driver.queryAll> = [];
    while (Date.now() < deadline) {
      opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
      if (opts.length === 4 && opts[0]?.selected !== true && opts[1]?.selected === true) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(opts[0]?.selected).toBeFalsy();
    expect(opts[1]?.selected).toBe(true);
  });

  it("Escape dismisses the recovery card", async () => {
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    expect(driver.query("id=ideal-halt-card")).toBeNull();
  });
});
