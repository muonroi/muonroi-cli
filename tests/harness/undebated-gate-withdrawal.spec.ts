/**
 * undebated-gate-withdrawal.spec.ts — E2E net for the card-withdrawal fix.
 *
 * ## The measured defect (session 697419024ec8)
 *
 * `/ideal`'s undebated-criteria gate (`src/product-loop/undebated-criteria-gate.ts`)
 * opened an askcard, got no answer within its 10-minute deadline, and resolved
 * to `unattended: true, action: "council"` — the run halted, by design. But the
 * card STAYED ON SCREEN. 46 minutes later the user answered it; nothing ever
 * happened — no further `interaction_logs` row, no `debug.log` line. The user
 * believed they were making a live decision on a run that had already stopped.
 *
 * ## The test seam
 *
 * Reaching the gate through a real council debate would require engineering a
 * mock-LLM fixture that reproduces the debate's own stance-evaluation JSON
 * shape well enough to leave one criterion with every panelist's mark `null` —
 * a large, error-prone surface to reverse-engineer blind. `/ideal resume
 * <runId>` gives a much narrower, ALREADY-DOCUMENTED path to the exact same
 * gate call (`src/product-loop/index.ts` around the "F8b" comment block): when
 * a run directory has no interrupted debate checkpoint, `runResume` reads
 * `undebated-criteria.json` off disk (written by the real
 * `writeUndebatedStanceRecord` export) and asks the SAME card — no debate, no
 * model calls, needed at all. This spec pre-seeds that run directory with the
 * repo's own `createRun` / `writeManifest` / `writeUndebatedStanceRecord`
 * helpers (not hand-authored JSON) and drives `/ideal resume <runId>` in a
 * real spawned TUI with `MUONROI_UNDEBATED_GATE_TIMEOUT_MS` set low.
 *
 * ## The contract change (b014c9b9) — two blocks
 *
 * Since b014c9b9 the TUI's main agent is the ORCHESTRATOR role, and
 * runProductLoopV1's `executionRole === "orchestrator"` branch
 * (src/orchestrator/orchestrator.ts) hands EVERY `/ideal` subcommand — resume
 * included — to main's own coordination turn instead of the legacy product
 * loop (design authority: docs/investigations/orchestrator-only-2026-10-17.md).
 * Driving the default TUI into `runResume` therefore no longer reaches the gate;
 * that is why this spec's 20s askcard-open wait timed out.
 *
 *  - "user-facing main" pins the new contract: `/ideal resume` is handed to main
 *    and no foreground gate card opens, so none can outlive its waiter.
 *  - "retained lifecycle" keeps the ORIGINAL assertions, unchanged, against an
 *    infrastructure-role Agent — the role the retained product loop still runs
 *    for — via the test-only entry b014c9b9 added for the same purpose
 *    (helpers.ts infrastructureRoleSpawn).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { createRun } from "../../src/flow/run-manager.js";
import { writeManifest } from "../../src/product-loop/artifact-io.js";
import { writeUndebatedStanceRecord } from "../../src/product-loop/undebated-criteria-gate.js";
import type { CouncilStanceRow } from "../../src/types/index.js";
import { infrastructureRoleSpawn, spawnHarness } from "./helpers.js";

const MOCK_KEY = ["muonroi", "undebated", "gate", "net", "mock", "key"].join("-");
/** Test-only gate deadline (undebated-criteria-gate.ts resolveUndebatedGateTimeoutMs). */
const GATE_TIMEOUT_MS = 1_200;

/** The criterion left engaged by nobody — the exact shape `findUndebatedCriteria` fires on. */
const UNDEBATED_ROW: CouncilStanceRow = {
  criterion: "Ship the analyzers as an installable NuGet package",
  met: false,
  stances: { architect: null, engineer: null, researcher: null },
};

type UsageEvent = Extract<LiveEvent, { kind: "usage" }>;

/**
 * Seed a run with the REAL production writers — not hand-authored JSON — so
 * the spec exercises the actual on-disk format `/ideal resume` reads.
 */
async function seedRun(cwd: string): Promise<{ runId: string; runDir: string }> {
  const flowDir = join(cwd, ".muonroi-flow");
  const run = await createRun(flowDir);
  await writeManifest(flowDir, run.id, {
    idea: "Ship the code-standards analyzers",
    doneThreshold: 0.7,
    createdAt: new Date(),
  });
  const runDir = join(flowDir, "runs", run.id);
  await writeUndebatedStanceRecord(runDir, [UNDEBATED_ROW]);
  return { runId: run.id, runDir };
}

describe("undebated-criteria gate — user-facing main (orchestrator role)", () => {
  let cwd: string;
  let runId: string;
  let runDir: string;
  let seededRecord: string;
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let driver: Driver;
  const mainTurns: UsageEvent[] = [];

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "muonroi-undebated-gate-"));
    ({ runId, runDir } = await seedRun(cwd));
    seededRecord = readFileSync(join(runDir, "undebated-criteria.json"), "utf8");

    ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
      env: {
        SILICONFLOW_API_KEY: MOCK_KEY,
        // Kept short so that if a future change routes resume back through the
        // legacy gate, the card would open AND time out inside the window below.
        MUONROI_UNDEBATED_GATE_TIMEOUT_MS: String(GATE_TIMEOUT_MS),
      },
      cwd,
    });
    driver = ctx.driver;
    void (async () => {
      for await (const e of driver.events((ev) => ev.kind === "usage" && ev.source === "message")) {
        mainTurns.push(e as UsageEvent);
      }
    })();

    await driver.wait_for({ idle: true, timeoutMs: 20_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.proc?.kill();
    ctx?.cleanup?.();
    bestEffortRemoveSync(cwd, "tests/harness/undebated-gate-withdrawal.spec.ts");
  });

  it("resume is handed to main and opens no foreground gate card that could outlive its waiter", async () => {
    driver.type(`/ideal resume ${runId}`);
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    const enteredAt = Date.now();
    driver.press("Enter");

    // 1) The resume is echoed as the user's turn and main coordinates it.
    await driver.wait_for({ selector: 'id=msg-0 role=listitem name~="/ideal resume"', timeoutMs: 10_000 });
    expect(driver.query("id=msg-0")?.name).toBe(`user:/ideal resume ${runId}`);
    await expect.poll(() => mainTurns.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });

    // 2) Observe past the gate deadline (with margin) before concluding that
    //    no gate card opened, then check the whole event history.
    const remaining = GATE_TIMEOUT_MS * 3 - (Date.now() - enteredAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    expect(driver.last_event("askcard-open")).toBeNull();
    expect(driver.last_event("askcard-withdrawn")).toBeNull();
    expect(driver.query("id=askcard")).toBeNull();
    expect(driver.query("role=textbox")?.role).toBe("textbox");

    // 3) The run's undebated-criteria record is left intact for main to read.
    expect(readFileSync(join(runDir, "undebated-criteria.json"), "utf8")).toBe(seededRecord);
  }, 45_000);
});

describe("undebated-criteria gate — withdrawal E2E, retained lifecycle (session 697419024ec8)", () => {
  let cwd: string;
  let runId: string;
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let driver: Driver;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "muonroi-undebated-gate-infra-"));
    ({ runId } = await seedRun(cwd));

    const infra = infrastructureRoleSpawn();
    ctx = await spawnHarness({
      entry: infra.entry,
      extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
      env: {
        ...infra.env,
        SILICONFLOW_API_KEY: MOCK_KEY,
        // Test-only seam documented in undebated-criteria-gate.ts —
        // resolveUndebatedGateTimeoutMs(). Short enough to keep this spec
        // fast, long enough that the askcard-open assertion below cannot
        // race it.
        MUONROI_UNDEBATED_GATE_TIMEOUT_MS: String(GATE_TIMEOUT_MS),
      },
      cwd,
    });
    driver = ctx.driver;

    await driver.wait_for({ idle: true, timeoutMs: 20_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.proc?.kill();
    ctx?.cleanup?.();
    bestEffortRemoveSync(cwd, "tests/harness/undebated-gate-withdrawal.spec.ts");
  });

  it("opens the undebated-criteria card, then withdraws it on timeout with a notice", async () => {
    driver.type(`/ideal resume ${runId}`);
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    driver.press("Enter");

    // 1) The card opens — same surface every askcard uses.
    await driver.wait_for({ event: "askcard-open", timeoutMs: 20_000 });
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    expect(driver.query("id=askcard")?.role).toBe("dialog");

    // 2) The deadline elapses — the withdrawal event must reach the wire.
    await driver.wait_for({ event: "askcard-withdrawn", timeoutMs: 15_000 });
    const withdrawn = driver.last_event("askcard-withdrawn") as Extract<LiveEvent, { kind: "askcard-withdrawn" }>;
    expect(withdrawn).toBeDefined();
    expect(withdrawn.reason).toBe("timeout");
    expect(withdrawn.notice.toLowerCase()).toContain("not answered within");
    expect(withdrawn.notice).toContain(`/ideal resume ${runId}`);
    expect(withdrawn.notice.toLowerCase()).toMatch(/ask again/);

    // 3) The card must be GONE — this is the whole point of the fix. A late
    // keypress after this point has nothing to land on.
    await driver.wait_for({ idle: true, timeoutMs: 5_000 }).catch((err: unknown) => {
      // idle may already be current; the node check below is the real assertion.
      console.error(
        `[undebated-gate-withdrawal.spec] post-withdrawal idle wait did not fire: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    expect(driver.query("id=askcard")).toBeNull();
  }, 45_000);
});
