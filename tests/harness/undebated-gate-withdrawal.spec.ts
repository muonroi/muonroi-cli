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
 * ## What this proves
 *
 * 1. `askcard-open` fires for the undebated-criteria card (the SAME surface
 *    every other askcard uses).
 * 2. Once the (short, test-only) deadline elapses, an `askcard-withdrawn`
 *    event fires carrying the notice text — the generic withdrawal mechanism
 *    reaches the wire from a real running process, not just a unit mock.
 * 3. The `id=askcard` node is GONE from the live frame afterward — the fix's
 *    whole point: a card whose waiter gave up must not keep looking live.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRun } from "../../src/flow/run-manager.js";
import { writeManifest } from "../../src/product-loop/artifact-io.js";
import { writeUndebatedStanceRecord } from "../../src/product-loop/undebated-criteria-gate.js";
import type { CouncilStanceRow } from "../../src/types/index.js";
import { spawnHarness } from "./helpers.js";

const MOCK_KEY = ["muonroi", "undebated", "gate", "net", "mock", "key"].join("-");

/** The criterion left engaged by nobody — the exact shape `findUndebatedCriteria` fires on. */
const UNDEBATED_ROW: CouncilStanceRow = {
  criterion: "Ship the analyzers as an installable NuGet package",
  met: false,
  stances: { architect: null, engineer: null, researcher: null },
};

describe("undebated-criteria gate — withdrawal E2E (session 697419024ec8)", () => {
  let cwd: string;
  let runId: string;
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let driver: Driver;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "muonroi-undebated-gate-"));
    const flowDir = join(cwd, ".muonroi-flow");

    // Seed the run with the REAL production writers — not hand-authored JSON —
    // so this spec is exercising the actual on-disk format `/ideal resume`
    // reads, not a guess at it.
    const run = await createRun(flowDir);
    runId = run.id;
    await writeManifest(flowDir, runId, {
      idea: "Ship the code-standards analyzers",
      doneThreshold: 0.7,
      createdAt: new Date(),
    });
    await writeUndebatedStanceRecord(join(flowDir, "runs", runId), [UNDEBATED_ROW]);

    ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
      env: {
        SILICONFLOW_API_KEY: MOCK_KEY,
        // Test-only seam documented in undebated-criteria-gate.ts —
        // resolveUndebatedGateTimeoutMs(). Short enough to keep this spec
        // fast, long enough that the askcard-open assertion below cannot
        // race it.
        MUONROI_UNDEBATED_GATE_TIMEOUT_MS: "1200",
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
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
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
    await driver.wait_for({ idle: true, timeoutMs: 5_000 }).catch(() => {
      /* idle may already be current; the node check below is the real assertion */
    });
    expect(driver.query("id=askcard")).toBeNull();
  }, 45_000);
});
