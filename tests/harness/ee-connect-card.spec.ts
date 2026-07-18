/**
 * ee-connect-card.spec.ts
 *
 * E2E: `/ee setup` opens the inline "connect the brain" card
 * (id=ee-connect-card) instead of demanding url+token as slash args.
 *
 * Note on the boot-time nudge: index.ts only evaluates the EE nudge on an
 * INTERACTIVE boot (`process.stdin.isTTY`), which is false under the harness's
 * piped stdio — so this spec drives the explicit `/ee setup` path. The nudge's
 * snooze/migration logic is unit-covered in src/ee/__tests__/ee-connect.test.ts.
 *
 * Setup: temp HOME with NO ~/.experience/config.json (EE unconfigured).
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/ee-connect-card.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("EE connect card E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muonroi-ee-connect-home-"));

    const ctx = await spawnHarness({
      cwd: home,
      env: { MUONROI_NO_SHELL_HOLD: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // Mount guard: React up before driving the slash command.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("`/ee setup` opens the connect card as a modal", async () => {
    driver.type("/ee setup");
    driver.press("Enter");
    await driver.wait_for({ selector: "id=ee-connect-card", timeoutMs: 20_000 });
    const card = driver.query("id=ee-connect-card");
    expect(card).not.toBeNull();
    expect(card?.isModal).toBe(true);
  });

  it("offers hosted / local / how-it-works / not-now actions", async () => {
    const actions = driver.queryAll("id*=ee-connect-action-");
    expect(actions.length).toBe(4);
    expect(driver.query("id=ee-connect-action-hosted")).not.toBeNull();
    expect(driver.query("id=ee-connect-action-local")).not.toBeNull();
  });

  it("esc dismisses (snooze) — the card leaves the tree", async () => {
    driver.press("Escape");
    // wait_for has no "absent" condition — poll for the card leaving the tree.
    const deadline = Date.now() + 10_000;
    while (driver.query("id=ee-connect-card") !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(driver.query("id=ee-connect-card")).toBeNull();
  });
});
