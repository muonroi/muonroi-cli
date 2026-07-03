/**
 * tests/harness/discovery-askcard.spec.ts
 *
 * E2E test for the PIL discovery interview askcard:
 * - spawns TUI with --mock-llm using discovery-askcard.json fixture
 * - types a vague request → PIL discovery fires → model returns 2 ModelCards
 * - askcard modal appears with events
 * - user can navigate options
 *
 * This drives the TUI like a real user (native spawn, no unit-test mock).
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("discovery askcard E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;

  beforeAll(async () => {
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-discovery-askcard-"));
    const ctx = await spawnHarness({
      cwd: greenfield,
      fixturesDir: join(__dirname, "fixtures/llm-discovery-askcard"),
      env: {
        // Force EE unreachable so PIL discovery routing is deterministic (the
        // LLM-mock fallback) rather than an EE-informed decision. On CI the
        // default EE URL is reachable, so the classifier routed away from the
        // discovery-askcard path and id=askcard never opened → 90s timeout.
        // Mirrors determinism.spec + council-flow.spec.
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      },
    });
    proc = ctx.proc;
    proc.stderr?.on("data", (d) => console.log("STDERR:", d.toString()));
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    // CI runners (shared 2-core) cold-boot the agent-mode TUI in 25–46s under
    // contention — far longer than a dev box — so the boot-gate idle wait must
    // comfortably exceed that, else the beforeAll times out before React mounts.
    await driver.wait_for({ idle: true, timeoutMs: 60_000 });
    await driver.wait_for({ selector: "id=composer", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    try {
      // rmSync(greenfield, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it("composer accepts input on startup", () => {
    expect(driver.query("id=composer")?.role).toBe("textbox");
  });

  it("shows discovery askcard for a vague request", async () => {
    driver.type("build a web app");
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    driver.press("Enter");
    // PIL discovery runs model → returns 2 cards → askcard modal appears.
    // Under CI CPU contention the first model round-trip is slow, so allow a
    // wide window (the per-it timeout below must exceed the sum of these waits).
    await driver.wait_for({ event: "askcard-open", timeoutMs: 90_000 });
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 10_000 });
    expect(driver.query("id=askcard")?.role).toBe("dialog");
  }, 150_000);

  it("can navigate discovery askcard options", async () => {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 30_000 });
    driver.press("Down");
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    const selected = driver.queryAll("role=button").find((n) => n.selected);
    expect(selected).toBeDefined();
  }, 60_000);
});
