import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness, waitForDelegation } from "./helpers.js";

// Contract since b014c9b9 (orchestrator role, the TUI main agent): `/council
// <topic>` no longer runs the council in the foreground. runCouncilV2's
// `executionRole === "orchestrator" && !infrastructure` branch
// (src/orchestrator/orchestrator.ts) starts a durable BACKGROUND council
// (startCouncil → delegations.ts spawnWorker) and yields its launch receipt;
// the detached child (src/index.ts council delegation) runs the existing full
// debate/synthesis algorithm headless and the host delivers the result back to
// main, waking it. Design authority: docs/investigations/
// orchestrator-only-2026-10-17.md ("User-facing council becomes an on-demand
// background delegation"). The foreground council_phase chunks that rendered
// <Semantic id="council-phases"> are therefore never emitted in the main TUI —
// which is why this spec's 90s id=council-phases wait timed out. The council's
// phase/status record is now the job's durable trace, asserted below.

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable" and resolveParticipants returns >= 2 roles.
// The mock-llm short-circuit means this value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");
const TOPIC = "analyze trade-offs for the project";

type UsageEvent = Extract<LiveEvent, { kind: "usage" }>;

// CI-quarantined (runs locally + pre-push, skipped only on CI). This full
// council flow is too heavy for the shared 2-core GitHub runner: after a
// 25–46s cold boot the (then foreground) multi-round council debate could not
// reach id=council-phases inside the 90s wait_for, and all 3 vitest retries
// hit the same wall (measured 270s/file, red 6+ weeks). The gate stays honest —
// describe.skipIf is exempt from lint:harness-skips (env guard, not coverage).
// Tracked: needs a lighter council fixture or a self-hosted multi-core runner.
// Whether CI can run the current background-council flow has not been measured.
describe.skipIf(!!process.env.CI)("council flow E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;
  let cliHome: string;
  const mainTurns: UsageEvent[] = [];

  beforeAll(async () => {
    // Greenfield cwd → the council's conversationContext snapshot is instant
    // (no large-repo scan), so the background council finishes in seconds.
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-council-e2e-"));
    // Isolated CLI home so the only delegation records this spec reads are the
    // ones its own run created (vitest-setup otherwise shares one per worker).
    cliHome = join(greenfield, ".muonroi-cli");
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
      // the provider is reachable. Without it, resolveParticipants returns [] and
      // runCouncil exits early before any debate.
      env: {
        SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY,
        MUONROI_DEBUG_MOCK_MODEL: "1",
        MUONROI_CLI_HOME: cliHome,
        // Force EE unreachable so routing is deterministic (no EE-informed
        // decision on a host where the default EE URL resolves). Mirrors the
        // proven determinism.spec pattern.
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      },
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

    // CI cold-boot (25–46s under 2-core contention) can exceed a 15s idle gate.
    await driver.wait_for({ idle: true, timeoutMs: 60_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    bestEffortRemoveSync(greenfield, "tests/harness/council-flow.spec.ts");
  });

  it("typing /council surfaces the slash menu", async () => {
    driver.type("/council");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 10_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu and clear the input before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  // NOTE: /council with no topic returns the help string (not __COUNCIL__). The
  // topic must be included in the command so the slash handler dispatches
  // runCouncilV2.
  it("full council flow runs as a background job, completes every phase and wakes main with its result", async () => {
    // Type the full command including the topic. The slash menu opens on "/" and
    // the filter narrows as we type — once the query is "council analyze..." no
    // item matches, so Enter falls through to the textarea submit handler with
    // the full "/council <topic>" text. Wait for idle after type() so React
    // commits the slashSearchQuery state updates before Enter arrives.
    driver.type(`/council ${TOPIC}`);
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");

    // 1) The launch is visible in the transcript: the user's command, then the
    //    launch receipt naming the job. Gate on the receipt before it can be
    //    followed by main's wake-up turn.
    await driver.wait_for({ selector: 'role=listitem name~="Delegation started:"', timeoutMs: 30_000 });
    expect(driver.query("id=msg-0")?.name).toMatch(/^user:\/council analyze trade-offs/);
    const receipt = driver.query('role=listitem name~="Delegation started:"')?.name ?? "";
    // The listitem name is display text and can be clipped mid-id (measured in a
    // full-suite run: "launched nimble-emerald-badge" vs record id
    // "nimble-emerald-badger"), so the screen gives a PREFIX of the job id. Find
    // the record by what it is (the council job for this topic), then prove the
    // receipt names that same job.
    const shownId = /Delegation started: ([a-z]+-[a-z]+-[a-z]+)/.exec(receipt)?.[1];
    expect(shownId).toBeDefined();

    // 2) That job is a durable infrastructure council carrying the user's topic.
    const launched = await waitForDelegation(
      cliHome,
      (r) => r.kind === "council" && r.council?.topic === TOPIC,
      10_000,
      `council job for "${TOPIC}"`,
    );
    expect(launched.id.startsWith(shownId!)).toBe(true);
    const jobId = launched.id;
    expect(launched.kind).toBe("council");
    expect(launched.executionRole).toBe("infrastructure");
    expect(launched.council?.topic).toBe(TOPIC);
    expect(launched.council?.reason).toBe("User requested council");

    // 3) The full council flow completed in the background: every phase ran in
    //    order with a real panel, and a synthesis was saved.
    const done = await waitForDelegation(
      cliHome,
      (r) => r.id === jobId && r.status === "complete",
      90_000,
      `${jobId} complete`,
    );
    const phases = (done?.councilTrace?.stats?.phases ?? []).map((p) => p.name);
    expect(phases).toEqual(expect.arrayContaining(["clarify+preflight", "plan_debate", "debate"]));
    expect(phases.indexOf("plan_debate")).toBeGreaterThan(phases.indexOf("clarify+preflight"));
    expect(phases.indexOf("debate")).toBeGreaterThan(phases.indexOf("plan_debate"));
    expect(done?.councilTrace?.participants?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(done?.councilTrace?.synthesis?.trim().length ?? 0).toBeGreaterThan(0);
    expect(done?.resultVersion).toMatch(/^[0-9a-f]{64}$/);

    // 4) The host delivered exactly that result version to main, which was
    //    woken for a turn of its own. /council itself streams no main turn, so
    //    this is the first.
    await waitForDelegation(
      cliHome,
      (r) => r.id === jobId && r.deliveredVersion === done.resultVersion,
      30_000,
      `${jobId} delivered to main`,
    );
    await expect.poll(() => mainTurns.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
