import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let greenfield: string;

  beforeAll(async () => {
    // Spawn in a FRESH greenfield dir, not the repo root. The /ideal discover
    // phase scans the cwd; on the large muonroi-cli repo that scan dominates
    // wall-clock and is highly variable (28s..>40s) — the exact reason the
    // status-card assertion below was skipped. In an empty dir discover is
    // instant, so product_status_card emits in <1s, deterministically.
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-ideal-e2e-"));
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY },
      cwd: greenfield,
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
    try {
      rmSync(greenfield, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it("typing /ideal surfaces the slash menu", async () => {
    driver.type("/ideal");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  it("ideal status card renders after starting a run", async () => {
    // `--force-council` forces the full council/loop path (runStart) regardless
    // of complexity / existing-repo bypass. The loop-driver emits an initial
    // product_status_card right after the (instant, in greenfield) discover
    // phase — before the gather askcard blocks — so id=ideal-status appears
    // without driving the rest of the flow. This is also the end-to-end smoke
    // for a greenfield "build X" prompt flowing through /ideal.
    driver.type("/ideal build a counter --max-sprints 1 --force-council");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    // Observed ~0.5s in greenfield; 25s is a generous robustness margin.
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 25_000 });
    expect(driver.query("id=ideal-status")).toBeTruthy();
  }, 35_000);

  it("status card exposes per-stage listitems", async () => {
    // ProductStatusCard renders <Semantic id="ideal-phase-sprint" role="listitem">,
    // id="ideal-phase-cost", and id="ideal-phase-criteria" as children of
    // id=ideal-status (visible once product_status_card fired in the prev test).
    await driver.wait_for({ selector: "id=ideal-status", timeoutMs: 10_000 });
    expect(driver.query("id=ideal-phase-sprint")).toBeTruthy();
    expect(driver.query("id=ideal-phase-cost")).toBeTruthy();
    const phases = driver.queryAll("role=listitem");
    expect(phases.length).toBeGreaterThan(0);
  }, 15_000);
});
