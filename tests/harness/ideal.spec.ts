import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { readDelegationRecords, spawnHarness, waitForDelegation } from "./helpers.js";

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable". The mock-llm short-circuit means this
// value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

type UsageEvent = Extract<LiveEvent, { kind: "usage" }>;

// Contract since b014c9b9 ("harden native flow and scoped worker
// orchestration"): the TUI main agent is the ORCHESTRATOR role and `/ideal`
// no longer runs the legacy foreground product loop. runProductLoopV1's
// `executionRole === "orchestrator"` branch (src/orchestrator/orchestrator.ts)
// launches the `--force-council` council as a durable BACKGROUND delegation
// (startCouncil → delegations.ts spawnWorker, executionRole "infrastructure")
// and hands the request to main's own coordination turn. The design authority
// is docs/investigations/orchestrator-only-2026-10-17.md ("User-facing council
// becomes an on-demand background delegation"). The legacy loop is what emitted
// `product_status_card` → <Semantic id="ideal-status">; it is no longer reached
// from the TUI, which is why this spec's id=ideal-status wait timed out after
// 25s. The run's live state is now the durable delegation record plus main's
// turns, and that is what is asserted here.
describe("ideal E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;
  let cliHome: string;
  const mainTurns: UsageEvent[] = [];

  beforeAll(async () => {
    // Greenfield cwd: the council's conversationContext snapshot is instant
    // (no large-repo scan), so the background job finishes in seconds.
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-ideal-e2e-"));
    // Isolated CLI home so the only delegation records this spec reads are the
    // ones its own run created (vitest-setup otherwise shares one per worker).
    cliHome = join(greenfield, ".muonroi-cli");
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY, MUONROI_CLI_HOME: cliHome },
      cwd: greenfield,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    // Main's model turns (source=message), collected for the whole run so the
    // wake-up turn after the council finishes cannot be missed between tests.
    void (async () => {
      for await (const e of driver.events((ev) => ev.kind === "usage" && ev.source === "message")) {
        mainTurns.push(e as UsageEvent);
      }
    })();

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    bestEffortRemoveSync(greenfield, "tests/harness/ideal.spec.ts");
  });

  it("typing /ideal surfaces the slash menu", async () => {
    driver.type("/ideal");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  it("starting a run launches the forced council as a durable background job and hands the run to main", async () => {
    driver.type("/ideal build a counter --max-sprints 1 --force-council");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    // The run is echoed as the user's own turn in the transcript.
    await driver.wait_for({ selector: 'id=msg-0 role=listitem name~="/ideal"', timeoutMs: 10_000 });
    expect(driver.query("id=msg-0")?.name).toBe('user:/ideal "build a counter"');

    // `--force-council` convenes exactly one council, as an infrastructure job
    // carrying the user's idea and the parsed flags — not a foreground debate.
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
    expect(council?.agent).toBe("council");
    expect(council?.executionRole).toBe("infrastructure");
    expect(council?.council?.topic).toBe("build a counter");
    expect(council?.council?.reason).toBe("User explicitly requested --force-council");
    expect(JSON.parse(council?.council?.context ?? "{}")).toMatchObject({
      subcommand: "start",
      flags: { maxSprints: 1, forceCouncil: true },
    });

    // Main ran its own coordination turn for the run (it does not wait on the
    // council — the launch receipt tells it not to poll).
    await expect.poll(() => mainTurns.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  }, 35_000);

  it("the background council completes every stage and its result is delivered back to main", async () => {
    // The per-stage status the old ProductStatusCard listed now lives in the
    // job's durable trace: the council ran clarify+preflight → plan_debate →
    // debate with a real panel, produced a synthesis, and the host delivered
    // that exact result version to main, which was woken by it.
    const council = await waitForDelegation(
      cliHome,
      (r) => r.kind === "council" && r.status === "complete",
      30_000,
      "council complete",
    );
    const phases = (council?.councilTrace?.stats?.phases ?? []).map((p) => p.name);
    expect(phases).toEqual(expect.arrayContaining(["clarify+preflight", "plan_debate", "debate"]));
    expect(phases.indexOf("plan_debate")).toBeGreaterThan(phases.indexOf("clarify+preflight"));
    expect(phases.indexOf("debate")).toBeGreaterThan(phases.indexOf("plan_debate"));
    expect(council?.councilTrace?.participants?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(council?.councilTrace?.synthesis?.trim().length ?? 0).toBeGreaterThan(0);
    expect(council?.resultVersion).toMatch(/^[0-9a-f]{64}$/);

    await waitForDelegation(
      cliHome,
      (r) => r.id === council.id && r.deliveredVersion === council.resultVersion,
      15_000,
      "council result delivered to main",
    );
    // Delivery woke main for a second turn of its own (the coordination turn
    // above was the first).
    await expect.poll(() => mainTurns.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  }, 75_000);
});
