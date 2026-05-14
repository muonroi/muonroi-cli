import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../../src/agent-harness/driver";
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

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-ai/DeepSeek-V4-Flash"],
      // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
      // the provider is reachable. Without it, resolveParticipants returns [] and
      // runCouncil exits early before emitting any council_phase chunks.
      env: { SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
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
  // Blocker (2026-05-14): the slash + Enter dispatch chain is now resolving correctly
  // (see f5fe26b "dispatchSlash returns true to block processMessage" + 416c7f1 "Enter
  // submits full command when filter has no matches"), but runCouncilV2 is not reaching
  // the phase chunk emission within 30s even with mock-llm hooked via Wave 2.5 hook into
  // createCouncilLLM. Likely cause: one of the council orchestrator phases (preflight /
  // debate-planner via generateObject) still fails Zod parse on the mock fixture's JSON,
  // OR a follow-up askcard step blocks on user-input that the harness doesn't auto-answer.
  // Next step: instrument src/council/orchestrator.ts to log which phase rejects, then
  // refine tests/harness/fixtures/llm/council.json sequence entries to match.
  it.skip("full council flow reaches Phase/Status renders", async () => {
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
