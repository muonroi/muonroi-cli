/**
 * tests/harness/ee-timeout.spec.ts
 *
 * Phase 21 / Plan 02 / T6 — Harness E2E for the EE-observability surface.
 *
 * Coverage:
 *   1. `/ee-context status` toggles surface a toast via the same agentRuntime
 *      emitEvent sink that BB-retrieval timeouts use — verifies T2 (toast
 *      subscriber) + T3 (slash command) end-to-end through the spawned TUI.
 *   2. `/ee-context on|off` round-trip flips userSettings.eeBBContext and the
 *      toast text reflects the new value.
 *
 * Out of scope (skipped with reason):
 *   - End-to-end `bb-retrieval.*.timeout` event triggered by an unreachable EE.
 *     Requires either a writable `~/.experience/config.json` pointing at a
 *     stub HTTP server reachable from the spawned TUI process, or a TUI-side
 *     hook to override EE base URL via env. Neither exists today.
 *     Blocker: `src/ee/bb-retrieval.ts` calls `getCachedServerBaseUrl()` which
 *     reads `os.homedir()` — overriding HOME in spawn env is fragile on
 *     Windows (USERPROFILE vs HOME). The unit-level path (logEeFailure
 *     emits ee-timeout event) is already covered by
 *     `src/utils/__tests__/ee-logger.test.ts`.
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// Slow type — character-by-character with a small inter-key delay so React
// can flush the slash-menu state-setter between bursts. Without this, all
// chars after `/` arrive before `showSlashMenuRef.current` flips to true,
// which leaves `slashSearchQuery` empty and the menu's filter showing every
// item instead of the targeted ee-context-* one.
async function slowType(driver: Driver, text: string, perCharMs = 25): Promise<void> {
  for (const ch of text) {
    driver.type(ch);
    await new Promise((r) => setTimeout(r, perCharMs));
  }
}

describe("ee-timeout E2E (Phase 21 / Plan 02)", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash"],
      // Aggressive BB timeout so any real retrieval (if EE configured on the
      // host) emits ee-timeout fast. Defaults are loose enough that this
      // wouldn't fire otherwise.
      env: {
        MUONROI_BB_RETRIEVAL_TIMEOUT_MS: "100",
        MUONROI_PIL_SEARCH_TIMEOUT_MS: "500",
      },
      idleTimeoutMs: 20_000,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("/ee-context status produces a toast with id=toast naming the current value", async () => {
    await slowType(driver, "/ee-context status");
    driver.press("Enter");

    await driver.wait_for({ selector: "id=toast", timeoutMs: 5_000 });
    const node = driver.query("id=toast");
    expect(node?.role).toBe("toast");
    // Toast name carries the visible text ("BB context: ON" or "BB context: OFF").
    expect(node?.name).toMatch(/BB context:\s*(ON|OFF)/);
  });

  it("/ee-context off flips the setting and the next status shows OFF", async () => {
    await slowType(driver, "/ee-context off");
    driver.press("Enter");

    // The previous test left a toast on screen — poll until the rendered
    // toast text reflects the new "OFF" value rather than asserting on the
    // immediate snapshot.
    const deadline = Date.now() + 5_000;
    let offToastName: string | undefined;
    while (Date.now() < deadline) {
      const t = driver.query("id=toast");
      if (t?.name === "BB context: OFF") {
        offToastName = t.name;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(offToastName).toBe("BB context: OFF");

    // Issue status to confirm the flip persisted in the live process.
    await slowType(driver, "/ee-context status");
    driver.press("Enter");
    // Same polling pattern — wait for the toast text to flip.
    const deadline2 = Date.now() + 5_000;
    let statusToastName: string | undefined;
    while (Date.now() < deadline2) {
      const t = driver.query("id=toast");
      if (t?.name === "BB context: OFF") {
        statusToastName = t.name;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(statusToastName).toBe("BB context: OFF");

    // Restore the default so other tests don't see OFF leakage.
    await slowType(driver, "/ee-context on");
    driver.press("Enter");
    const deadline3 = Date.now() + 5_000;
    while (Date.now() < deadline3) {
      const t = driver.query("id=toast");
      if (t?.name === "BB context: ON") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  // SKIP: end-to-end bb-retrieval timeout — see file header for the blocker.
  // Unit coverage of the event-emission shape lives in
  // `src/utils/__tests__/ee-logger.test.ts`.
  it.skip("emits ee-timeout with source starting with bb-retrieval when EE is unreachable", () => {
    // intentionally empty — blocked on writable ~/.experience/config.json or
    // an env-based EE base-URL override in the spawned TUI.
  });
});
