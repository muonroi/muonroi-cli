/**
 * point-to-existing.spec.ts — E2E harness spec for the point-to-existing flow (Task 5.4).
 *
 * Uses --inject-halt to surface the halt recovery card, then navigates to the
 * "Point to existing recipe" option and confirms the form renders.
 *
 * Sprint re-entry is deferred (detectVerifyRecipe is not wired in app.tsx yet),
 * so this spec only asserts that the form appears and accepts input — the unit
 * tests in src/scaffold/__tests__/point-to-existing.spec.ts cover the logic.
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("point-to-existing form E2E", () => {
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

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before --inject-halt
    // mounts the halt card. Wait for it explicitly.
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("halt recovery card is visible on boot", async () => {
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
    const card = driver.query("id=ideal-halt-card");
    expect(card).not.toBeNull();
  });

  it("navigate Down to select 'Point to existing recipe'", async () => {
    // Default selection is index 0 (init_new). Press Down once to reach index 1.
    driver.press("Down");
    // Poll for state to actually update — idle fires after 50ms but React's
    // selected state commit may land within that window, creating a race.
    let opts: ReturnType<typeof driver.queryAll> = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
      if (opts[1]?.selected === true) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(opts[1]?.selected).toBe(true);
  });

  it("Enter on 'Point to existing recipe' opens the form", async () => {
    driver.press("Return");
    await driver.wait_for({ selector: "id=point-to-existing-form", timeoutMs: 8_000 });
    const form = driver.query("id=point-to-existing-form");
    expect(form).not.toBeNull();
    expect(form?.role).toBe("dialog");
    expect(form?.name).toBe("Point to existing project");
  });

  it("halt card is dismissed after selecting the option", () => {
    const card = driver.query("id=ideal-halt-card");
    expect(card).toBeNull();
  });

  it("Escape dismisses the point-to-existing form", async () => {
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const form = driver.query("id=point-to-existing-form");
    expect(form).toBeNull();
  });
});
