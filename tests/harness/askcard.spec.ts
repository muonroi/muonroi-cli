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
      // Dedicated fixture dir. The shared tests/harness/fixtures/llm dir cannot
      // drive this flow: its council.json is a positional SEQUENCE whose entries
      // are consumed by every council call in order, so the clarifier receives
      // whichever entry happens to be next (today: filler with no JSON array) and
      // asks nothing. llm-askcard/askcard.json answers the clarifier with one
      // real question on every call, so the askcard is reached deterministically
      // in the first second regardless of how many calls precede it.
      fixturesDir: join(__dirname, "fixtures/llm-askcard"),
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
    // Force the council/loop path. gather delegates to runClarification, which
    // asks the leader for clarification questions; the fixture returns one, so a
    // council_question chunk is emitted and use-app-logic renders
    // CouncilQuestionCard inside <Semantic id="askcard" role="dialog" isModal>
    // and fires askcard-open. The run then BLOCKS on respondToQuestion, which is
    // what keeps the card up for the navigation test below.
    //
    // Until a9a509c6 this spec passed on something else entirely: the clarifier
    // asked nothing, scoping synthesis parsed no ProductSpec, and the old
    // `productSpec = {} as ProductSpec` fallback marched on to runPreflight —
    // whose approve card then still rendered under id=askcard. a9a509c6 removed
    // that silent degradation (correctly) and the card had nowhere to come from;
    // the preflight card is also id=askcard-preflight now. Assert the clarify
    // card the spec always claimed to be testing instead.
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
