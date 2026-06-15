/**
 * tests/harness/cost-leak-g1-tui.spec.ts
 *
 * Phase F G1 — TUI E2E: when the OAuth registry exposes
 * `unsupportedParams: ["maxOutputTokens"]`, the orchestrator's streamText
 * call MUST omit `maxOutputTokens` so the backend does not 400.
 *
 * Compared to the unit-level cost-leak-g1.spec.ts (drives streamText
 * directly with a stubFactory), this spec spawns the actual TUI process,
 * sends a real user prompt through the composer, and reads the
 * doStreamCalls dumped from the child via MUONROI_MOCK_MODEL_DUMP.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CostLeakHarness,
  exitTuiAndWaitForDump,
  makeTextStream,
  spawnCostLeakHarness,
} from "./cost-leak-tui-helpers.js";
import { assertParamAbsent, loadDumpedRecordings } from "./recording.js";

describe("G1 TUI: orchestrator drops maxOutputTokens when OAuth registry says it's unsupported", () => {
  let handle: CostLeakHarness;

  beforeAll(async () => {
    handle = await spawnCostLeakHarness({
      stream: makeTextStream("ok"),
      unsupportedParams: ["maxOutputTokens"],
    });
  }, 120_000);

  afterAll(() => {
    handle?.cleanup();
  });

  it("every recorded streamText call omits maxOutputTokens", async () => {
    handle.driver.type("hello");
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await handle.driver.wait_for({ idle: true, timeoutMs: 10_000 });
    // Ensure at least one doStream completed before we exit — the
    // continuous-dump hook fires after each call (see src/index.ts H3 hook).
    await new Promise((r) => setTimeout(r, 2000));

    await exitTuiAndWaitForDump(handle);

    const calls = loadDumpedRecordings(handle.dumpPath);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      assertParamAbsent(c, "maxOutputTokens");
    }
  }, 60_000);
});
