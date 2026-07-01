import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe("askcard E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;

  beforeAll(async () => {
    // Greenfield cwd → the /ideal discover phase is instant, so the council
    // gather askcard surfaces deterministically in <1s (vs. the repo-scan
    // variance that previously made this flow time out — see ideal.spec.ts).
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-askcard-e2e-"));
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

  it("composer accepts input on startup", () => {
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it("council question modal appears and is observable", async () => {
    // Force the council/loop path; the gather phase emits a council_question
    // chunk → app.tsx renders CouncilQuestionCard wrapped in
    // <Semantic id="askcard" role="dialog" isModal>. Drive via the askcard-open
    // event (fires ~0.4s in greenfield) for a deterministic wait.
    driver.type("/ideal build a counter --max-sprints 1 --force-council");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    await driver.wait_for({ event: "askcard-open", timeoutMs: 25_000 });
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    expect(driver.query("id=askcard")?.role).toBe("dialog");
  }, 35_000);

  it("can navigate askcard options with arrow keys", async () => {
    // The card from the previous test is still pending (unanswered). Navigate
    // its options and assert the selection moves.
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 10_000 });
    driver.press("Down");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const selected = driver.queryAll("role=button").find((n) => n.selected);
    expect(selected).toBeDefined();
  }, 15_000);
});
