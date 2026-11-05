/**
 * tests/harness/discovery-askcard.spec.ts
 *
 * E2E test for the clarification askcard a vague request produces:
 * - spawns TUI with --mock-llm using discovery-askcard.json fixture
 * - types a vague request → main (orchestrator role) asks via its ask_user tool
 * - askcard modal appears with the model's question + options, and events
 * - user can navigate options
 *
 * Contract change: this used to be PIL's discovery interview. bc8fe0ee made PIL
 * background-only (no clarificationProposer / interactionHandler is passed to
 * runPipeline any more — pinned by preprocessor-cancellation.test.ts "records
 * background phases without human questions"), so PIL cannot ask; the
 * orchestrator main asks questions itself (docs/investigations/
 * orchestrator-only-2026-10-17.md). The old spec timed out at 90s because the
 * fixture's card JSON was streamed into the transcript as main's plain reply.
 * That was masked on CI the whole time by the describe.skipIf below.
 *
 * This drives the TUI like a real user (native spawn, no unit-test mock).
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";

// CI-quarantined (runs locally + pre-push, skipped only on CI). The PIL
// discovery interview → askcard flow is too heavy for the shared 2-core GitHub
// runner: after a 25–46s cold boot the model round-trip never opens id=askcard
// inside the 90s wait_for, and all 3 vitest retries hit the same wall (red 6+
// weeks). Passes locally in <4s. describe.skipIf is exempt from
// lint:harness-skips (env guard, not coverage). Tracked: needs a lighter
// fixture or a self-hosted multi-core runner. Note: from bc8fe0ee on, the old
// PIL interview could not open the card on ANY machine (not only on CI);
// whether CI can run the current ask_user flow has not been measured.
describe.skipIf(!!process.env.CI)("discovery askcard E2E", () => {
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
    bestEffortRemoveSync(greenfield, "tests/harness/discovery-askcard.spec.ts");
  });

  it("composer accepts input on startup", () => {
    expect(driver.query("id=composer")?.role).toBe("textbox");
  });

  it("shows discovery askcard for a vague request", async () => {
    driver.type("build a web app");
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    driver.press("Enter");
    // Main's first step is an ask_user call → askcard modal appears.
    // Under CI CPU contention the first model round-trip is slow, so allow a
    // wide window (the per-it timeout below must exceed the sum of these waits).
    await driver.wait_for({ event: "askcard-open", timeoutMs: 90_000 });
    const opened = driver.last_event("askcard-open") as Extract<LiveEvent, { kind: "askcard-open" }> | undefined;
    expect(opened?.phase).toBe("ask-user");
    expect(opened?.question).toBe("What do you want to build?");
    expect(opened?.optionCount).toBe(4);
    expect(opened?.defaultIndex).toBe(0);
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 10_000 });
    const card = driver.query("id=askcard");
    expect(card?.role).toBe("dialog");
    expect(card?.name).toBe("What do you want to build?");
    expect(driver.queryAll("role=button").map((n) => n.id)).toEqual([
      "askcard-option-web-app",
      "askcard-option-cli-tool",
      "askcard-option-exploring",
      "askcard-option-cancel",
    ]);
  }, 150_000);

  it("can navigate discovery askcard options", async () => {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 30_000 });
    // The default option starts selected; Down must MOVE the selection to the
    // second option, not merely leave "something" selected.
    expect(driver.query("id=askcard-option-web-app")?.selected).toBe(true);
    driver.press("Down");
    await driver.wait_for({ selector: "id=askcard-option-cli-tool selected", timeoutMs: 10_000 });
    const selected = driver.queryAll("role=button").filter((n) => n.selected);
    expect(selected.map((n) => n.id)).toEqual(["askcard-option-cli-tool"]);
  }, 60_000);
});
