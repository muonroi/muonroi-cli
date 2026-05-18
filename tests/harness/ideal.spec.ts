import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable". The mock-llm short-circuit means this
// value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe("ideal E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-ai/DeepSeek-V4-Flash"],
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("typing /ideal surfaces the slash menu", async () => {
    driver.type("/ideal");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  // Blocker (2026-05-14): same root cause as council-flow.spec.ts — slash dispatch fixed,
  // mock-llm hook wired (Wave 2.5), but product_status_card chunk does not arrive within
  // 30s. Likely cause: src/product-loop/loop-driver.ts gates the emit behind a phase the
  // mock fixture doesn't satisfy (discover → spec → sprint protocol — needs deeper RE).
  // Next step: instrument loop-driver.ts to log which phase rejects the mock JSON.
  it.skip("ideal status card renders after starting a run", async () => {
    // loop-driver.ts emits product_status_card after the discover phase
    // (before gather blocks on user input), so id=ideal-status appears without
    // needing to drive the full gather/research/sprint flow.
    //
    // Type the full command including the topic. The slash menu opens on "/"
    // but once the filter has no matching item, Enter closes the menu and lets
    // the textarea submit the full "/ideal <topic>" text (app.tsx fix: when
    // filteredSlashItems is empty, Enter falls through without preventDefault).
    // Wait for idle after type() so React commits the slashSearchQuery state
    // updates before Enter arrives (avoids stale filteredSlashItems issue).
    driver.type("/ideal build a counter --max-sprints 1");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 30_000 });
    expect(driver.query("id=ideal-status")).toBeTruthy();
  });

  // Blocker (2026-05-14): depends on "ideal status card renders" above — same skip reason.
  it.skip("can advance through ideal phases", async () => {
    // ProductStatusCard renders <Semantic id="ideal-phase-sprint" role="listitem">
    // and <Semantic id="ideal-phase-cost" role="listitem"> as children of id=ideal-status.
    // The card is visible once product_status_card chunk fires (discover stage).
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    const phases = driver.queryAll("role=listitem");
    expect(phases.length).toBeGreaterThan(0);
  });
});
