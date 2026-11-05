import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { readDelegationRecords, spawnHarness, waitForDelegation } from "./helpers.js";

const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe("askcard E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;
  let cliHome: string;

  beforeAll(async () => {
    // Greenfield cwd → the council's conversationContext snapshot is instant
    // (no large-repo scan), and main's turn starts in <1s.
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-askcard-e2e-"));
    // Isolated CLI home so the background council's durable record is the only
    // one this spec reads (vitest-setup otherwise shares one per worker pid).
    cliHome = join(greenfield, ".muonroi-cli");
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY, MUONROI_CLI_HOME: cliHome },
      // Dedicated fixture dir. llm-ask-user/ask-user.json scripts main's turn
      // (round 0 = an ask_user tool call) and answers every background council
      // call with one wildcard reply; the shared tests/harness/fixtures/llm dir
      // has neither (see the fixture's ___note fields). llm-askcard stays as the
      // integration test's legacy clarify-card fixture.
      fixturesDir: join(__dirname, "fixtures/llm-ask-user"),
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
    bestEffortRemoveSync(greenfield, "tests/harness/askcard.spec.ts");
  });

  it("composer accepts input on startup", () => {
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  });

  it("main's question modal appears and is observable while the forced council runs in the background", async () => {
    // Contract since b014c9b9 (orchestrator role, the TUI main agent): `/ideal`
    // no longer runs the legacy foreground product loop. runProductLoopV1's
    // `executionRole === "orchestrator"` branch (src/orchestrator/orchestrator.ts)
    // launches the `--force-council` council as a DURABLE BACKGROUND job and
    // hands the request to main's own turn. That council is headless — the
    // delegation child runs runCouncilV2 with skipClarification +
    // suppressPreDebateCards (src/index.ts, council delegation) — so the old
    // clarifier card this spec waited for can no longer exist; the 25s
    // askcard-open timeout was the clarifier that never runs. Questions to the
    // human now come from main itself via its ask_user tool
    // (docs/investigations/orchestrator-only-2026-10-17.md: "Main coordinates,
    // plans, asks questions"). The fixture's round 0 is main calling ask_user;
    // use-app-logic's setAskUserHandler renders CouncilQuestionCard under
    // <Semantic id="askcard" role="dialog"> and emits askcard-open, and the tool
    // BLOCKS until answered — which keeps the card up for the navigation test.
    driver.type("/ideal build a counter --max-sprints 1 --force-council");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    await driver.wait_for({ event: "askcard-open", timeoutMs: 25_000 });
    const opened = driver.last_event("askcard-open") as Extract<LiveEvent, { kind: "askcard-open" }> | undefined;
    expect(opened?.phase).toBe("ask-user");
    expect(opened?.question).toBe("Which counter behaviour should the build assume?");
    expect(opened?.optionCount).toBe(2);
    expect(opened?.defaultIndex).toBe(0);
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    const card = driver.query("id=askcard");
    expect(card?.role).toBe("dialog");
    expect(card?.name).toBe("Which counter behaviour should the build assume?");

    // `--force-council` must still convene a council — as the background job,
    // with the user's idea as its topic and the flag as its stated reason.
    const council = await waitForDelegation(cliHome, (r) => r.kind === "council", 15_000, "council launched");
    // Exactly one council (polled: a single read can miss a record mid-rename).
    await expect
      .poll(
        () =>
          readDelegationRecords(cliHome)
            .filter((r) => r.kind === "council")
            .map((r) => r.id),
        {
          timeout: 5_000,
        },
      )
      .toEqual([council.id]);
    expect(council?.executionRole).toBe("infrastructure");
    expect(council?.council?.topic).toBe("build a counter");
    expect(council?.council?.reason).toBe("User explicitly requested --force-council");
    expect(JSON.parse(council?.council?.context ?? "{}")).toMatchObject({
      subcommand: "start",
      flags: { maxSprints: 1, forceCouncil: true },
    });
  }, 45_000);

  it("can navigate askcard options with arrow keys", async () => {
    // The card from the previous test is still pending (ask_user blocks main's
    // turn). The default option starts selected; Down must move the selection
    // to the second option, not merely leave "something" selected.
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 10_000 });
    expect(driver.query("id=askcard-option-increment-only")?.selected).toBe(true);
    expect(driver.query("id=askcard-option-full-controls")?.selected).toBeFalsy();
    driver.press("Down");
    await driver.wait_for({ selector: "id=askcard-option-full-controls selected", timeoutMs: 5_000 });
    const selected = driver.queryAll("role=button").filter((n) => n.selected);
    expect(selected.map((n) => n.id)).toEqual(["askcard-option-full-controls"]);
  }, 15_000);
});
