import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// Unskipped: /council does not pop a picker dialog (goes straight to
// runCouncilRound). After Phase 8 the council renderers (CouncilPhaseTimeline,
// CouncilStatusList, CouncilMessageBubble, etc.) are wrapped in <Semantic> so
// the harness can observe them as they appear.

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable" and resolveParticipants returns >= 2 roles.
// The mock-llm short-circuit means this value is never sent to a real API.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

describe("council flow E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;

  beforeAll(async () => {
    // Greenfield cwd → the council's conversationContext snapshot is instant
    // (no large-repo scan), so the Clarification council_phase chunk reaches
    // app.tsx deterministically rather than racing the old 30s timeout.
    greenfield = mkdtempSync(join(tmpdir(), "muonroi-council-e2e-"));
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-ai/DeepSeek-V4-Flash"],
      // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
      // the provider is reachable. Without it, resolveParticipants returns [] and
      // runCouncil exits early before emitting any council_phase chunks.
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY },
      cwd: greenfield,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    try {
      rmSync(greenfield, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it("typing /council surfaces the slash menu", async () => {
    driver.type("/council");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 10_000 });
    expect(driver.query("id=slash-menu")?.name).toBe("Slash commands");
    // Press Escape to dismiss the menu and clear the input before the next test.
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  // Wave 2.5 wired globalThis.__muonroiMockLlm into createCouncilLLM.generate/debate/research
  // (src/council/llm.ts). council.json sequence fixture covers clarifier → spec synthesis →
  // debate-planner fallback. The council_phase chunk for "Clarification" is emitted immediately
  // before runPreflight blocks, so id=council-phases appears without needing to answer questions.
  //
  // NOTE: /council with no topic returns the help string (not __COUNCIL__). The topic must be
  // included in the command so app.tsx dispatches runCouncilV2.
  //
  // Un-skipped (2026-06-15): the prior 30s timeout was the council's
  // conversationContext repo snapshot scanning the large muonroi-cli repo —
  // variable and slow. Spawning in a greenfield cwd makes that snapshot
  // instant, so the Clarification council_phase chunk reaches app.tsx in <1s.
  // The mock-model now also implements doGenerate (debate-planner generateObject
  // no longer throws "Not implemented"; it falls through to the fallback plan).
  it("full council flow reaches Phase/Status renders", async () => {
    // Type the full command including the topic. The slash menu opens on "/" and
    // the filter narrows as we type — once the query is "council analyze..." no
    // item matches. app.tsx now falls through on Enter when filteredSlashItems
    // is empty: it closes the menu without key.preventDefault() so the textarea
    // submit handler fires with the full "/council <topic>" text.
    //
    // Wait for idle after type() so React commits the slashSearchQuery state
    // updates before Enter arrives — otherwise filteredSlashItems is still the
    // full list (stale state) and the Enter handler selects the first item.
    driver.type("/council analyze trade-offs for the project");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    // council_phase for "Clarification" fires before runPreflight blocks.
    await driver.wait_for({
      selector: "id=council-phases",
      timeoutMs: 30_000,
    });
    expect(driver.query("id=council-phases")).toBeTruthy();
  });
});
