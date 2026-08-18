import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable" and resolveParticipants returns >= 2 roles.
// The mock-llm short-circuit means this value is never sent to a real API.
// Mirrors council-flow.spec.ts / askcard.spec.ts.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

// Dedicated fixture directory, NOT the shared tests/harness/fixtures/llm/ pool.
// packages/agent-harness-core/src/mock-llm.ts tries every sequence fixture in
// the loaded dir on EVERY llm.generate()/debate()/research() call, so a
// council-shaped sequence fixture dropped into the shared pool would compete
// with council.json/ideal.json on every OTHER spec that uses the default
// fixtures dir — the exact hazard helpers.ts documents for `fixturesDir`.
const FIXTURES_DIR = resolve("tests/harness/fixtures/llm/council-plan-gate");

describe("council intent gate + plan card", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;

  beforeAll(async () => {
    // Greenfield cwd — per CLAUDE.md caveat 2, spawning a council spec in the
    // repo root makes the discover phase / conversationContext snapshot scan
    // muonroi-cli itself (28s..>40s, highly variable), which races the
    // wait_for timeout and gets misattributed as flakiness. A fresh temp cwd
    // makes that snapshot instant.
    greenfield = mkdtempSync(join(tmpdir(), "council-plan-gate-"));
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
      // the provider is reachable; without it resolveParticipants returns too
      // few roles for a debate. MUONROI_EE_BASE_URL points at a closed port so
      // the CQ-11 experience-warnings prefetch fails fast instead of racing a
      // real (possibly reachable) default host — mirrors council-flow.spec.ts.
      // MUONROI_GSD_ASSESSOR=0 skips the leader-tier complexity assessor (an
      // unfixtured extra LLM call) — depth comes only from the fixture's
      // `classify` line, which is all this spec needs to trigger auto-council.
      // MUONROI_GSD_NATIVE=0 keeps the native GSD directive/mutation-gate
      // machinery out of scope: this spec asserts the intent gate, not the
      // GSD pipeline, and PIL still sets pilCtx.complexityTier regardless of
      // this flag (src/pil/layer4-gsd.ts sets it unconditionally).
      env: {
        SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY,
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
        MUONROI_GSD_ASSESSOR: "0",
        MUONROI_GSD_NATIVE: "0",
      },
      fixturesDir: FIXTURES_DIR,
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
    } catch (err) {
      // Best-effort temp cleanup — a leftover temp dir is not a test failure,
      // but a silent catch here would still hide a real cause (e.g. a file
      // still held open by a not-yet-dead child process).
      console.error(
        `[council-plan-gate.spec] temp cwd cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it("the launch card leads with the intent options", async () => {
    // Drives AUTO-council (a plain chat message PIL classifies as
    // taskType=plan / depth=heavy), not the `/council <topic>` slash command.
    //
    // History, since the original note here is now wrong: the `/council`
    // handler used to call `agent.runCouncilV2(topic, { convenePath: true })`
    // and the S1 gate was `!options?.convenePath`, so the slash command never
    // showed this card at all. Task 10 added `allowLaunchCard` (card shown, but
    // `convenePath` still skipped every consumer of the lock), and C2
    // (2026-08-06) split the flag into `suppressPreDebateCards` /
    // `suppressPostDebate` and made `/council` set NEITHER — so both entry
    // points now show this card and both reach the plan gate behind it.
    // Auto-council is kept as the driver here because it needs no slash parsing
    // and is the path a user hits without asking for a debate.
    driver.type("design the council intent-gate sentinel transition test");
    driver.press("Enter");

    // The S1 launch configurator (council/index.ts) is the FIRST askcard-open
    // in this run: the clarifier asks zero questions (fixture's clarify entry)
    // so the spec is judged ready and the preflight approve card auto-approves
    // (preflight.ts only emits its own askcard-open when NOT auto-approved).
    await driver.wait_for({ event: "askcard-open", timeoutMs: 60_000 });
    const e = driver.last_event("askcard-open");
    expect(e?.phase).toBe("council-setup");
    // 6 IntentKind options (intent-card.ts buildIntentOptions) + 5 shape
    // options (start / cheap / edit / refine / cancel from launch-card.ts).
    // The askcard-open LiveEvent carries optionCount but NOT the labels
    // (protocol.ts:221-230) — the interaction_logs DB row has optionLabels,
    // the event does not. Read the labels off the rendered card instead of
    // inventing a protocol field.
    expect(e?.optionCount).toBe(11);

    // Wait for the card to actually be on screen before reading it back —
    // askcard-open fires synchronously with the state setter, but render_text()
    // reads the current frame and could otherwise race React's commit.
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });

    // buildIntentOptions (src/council/intent-card.ts) renders ALL 6 IntentKind
    // labels on every S1 card — it only REORDERS so the leader's proposed kind
    // (debatePlan.outputShape.kind, "implementation_plan" in the fixture's
    // debate-planner-retry entry) comes first and gets " (recommended)"
    // appended to its label. That means
    // asserting the rendered text merely CONTAINS "implement" proves nothing:
    // the label is present at some position regardless of which kind won the
    // recommended slot, so a regression in coerceIntentKind or in the
    // reordering itself (the leader's pick silently not driving the
    // recommendation) would leave "implement" on screen and this test green.
    // Anchor to the specific option node instead — each option gets a stable
    // Semantic id of `askcard-option-${value}` (council-question-card.tsx) —
    // and assert its OWN rendered name carries the "(recommended)" suffix,
    // which intent-card.ts only appends to the option at index 0 post-reorder.
    const implementOption = driver.query("id=askcard-option-implementation_plan");
    expect(implementOption?.name).toMatch(/implement.*\(recommended\)/i);
  });
});
