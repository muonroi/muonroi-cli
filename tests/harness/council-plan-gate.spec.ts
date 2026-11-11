import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { infrastructureRoleSpawn, spawnHarness, waitForDelegation } from "./helpers.js";

// Placeholder value used by loadKeyForProvider — must be >= 20 chars so the
// provider is considered "reachable" and resolveParticipants returns >= 2 roles.
// The mock-llm short-circuit means this value is never sent to a real API.
// Mirrors council-flow.spec.ts / askcard.spec.ts.
const MOCK_PROVIDER_KEY = ["test", "mock", "provider", "noop"].join("-");

// Dedicated fixture directory, NOT the shared tests/harness/fixtures/llm/ pool.
// packages/agent-harness-core/src/mock-llm.ts consults every fixture in the
// loaded dir on EVERY llm.generate()/debate()/research() call, so a
// council-shaped fixture dropped into the shared pool would compete with
// council.json/ideal.json on every OTHER spec that uses the default fixtures
// dir — the exact hazard helpers.ts documents for `fixturesDir`.
const FIXTURES_DIR = resolve("tests/harness/fixtures/llm/council-plan-gate");
const TOPIC = "design the council intent-gate sentinel transition test";

// Contract since b014c9b9 (orchestrator role, the TUI main agent): `/council`
// was the last entry point that showed the S1 launch card (intent options +
// shape options, phase=council-setup). runCouncilV2's
// `executionRole === "orchestrator" && !infrastructure` branch
// (src/orchestrator/orchestrator.ts) now starts a durable BACKGROUND council
// instead, and the detached child runs runCouncilV2 with
// suppressPreDebateCards + skipClarification + skipPil (src/index.ts council
// delegation) — so no launch card, clarify card or plan gate is ever shown, and
// this spec's 60s askcard-open wait timed out. Design authority:
// docs/investigations/orchestrator-only-2026-10-17.md ("User-facing council
// becomes an on-demand background delegation").
//
// What the launch card protected survives in the new contract and is asserted
// here with the same anchor: the LEADER's proposed intent
// (debatePlan.outputShape.kind from the debate planner, "implementation_plan"
// in the fixture) must be the intent the council actually adopts — a
// regression in planDebate's parse/sanitize path (the leader's pick silently
// replaced by the generic fallback plan) fails the kind, stance and summary
// assertions below. Plus the new half of the contract: the human is not
// interrupted by a foreground card at all.
const COUNCIL_ENV = {
  SILICONFLOW_API_KEY: MOCK_PROVIDER_KEY,
  MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
  MUONROI_FLOW_ASSESSOR: "0",
  MUONROI_FLOW_NATIVE: "0",
};

function removeTempCwd(greenfield: string): void {
  try {
    rmSync(greenfield, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (err) {
    // Best-effort temp cleanup — a leftover temp dir is not a test failure,
    // but a silent catch here would still hide a real cause (e.g. a file
    // still held open by a not-yet-dead child process).
    console.error(
      `[council-plan-gate.spec] temp cwd cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Type `/council <TOPIC>` and submit it once the slash menu has settled. */
async function submitCouncil(driver: Driver): Promise<void> {
  const command = `/council ${TOPIC}`;
  driver.type(command);
  // Gate Enter on the composer holding the full command AND the UI settling:
  // the slash menu filters as the query grows, and an Enter that lands while
  // it still lists items selects the first item instead of submitting.
  await driver.wait_for({ selector: `id=composer value="${command}"`, timeoutMs: 15_000 });
  await driver.wait_for({ idle: true, timeoutMs: 10_000 });
  driver.press("Enter");
}

describe("council intent gate + plan card — user-facing main (orchestrator role)", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;
  let cliHome: string;

  beforeAll(async () => {
    // Greenfield cwd — per docs/agent-harness/HARNESS-GUIDE.md caveat 2, spawning a council spec in the
    // repo root makes the conversationContext snapshot scan muonroi-cli itself
    // (28s..>40s, highly variable). A fresh temp cwd makes that snapshot instant.
    greenfield = mkdtempSync(join(tmpdir(), "council-plan-gate-"));
    // Isolated CLI home so the only delegation record this spec reads is the
    // one its own /council created (vitest-setup otherwise shares one per worker).
    cliHome = join(greenfield, ".muonroi-cli");
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      // loadKeyForProvider reads SILICONFLOW_API_KEY (>= 20 chars) to decide if
      // the provider is reachable; without it resolveParticipants returns too
      // few roles for a debate. MUONROI_EE_BASE_URL points at a closed port so
      // the CQ-11 experience-warnings prefetch fails fast instead of racing a
      // real (possibly reachable) default host — mirrors council-flow.spec.ts.
      // MUONROI_FLOW_ASSESSOR=0 skips the leader-tier complexity assessor (an
      // unfixtured extra LLM call). MUONROI_FLOW_NATIVE=0 keeps the native FLOW
      // directive/mutation-gate machinery out of scope: this spec asserts the
      // council's intent, not the FLOW pipeline.
      env: { ...COUNCIL_ENV, MUONROI_CLI_HOME: cliHome },
      fixturesDir: FIXTURES_DIR,
      cwd: greenfield,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // `input-ready` is the readiness signal; idle can fire on the empty seq=0
    // frame before React mounts (see agent-mode.ts).
    await driver.wait_for({ event: "input-ready", timeoutMs: 60_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    removeTempCwd(greenfield);
  });

  it("the council adopts the leader's proposed intent without interrupting the user with a launch card", async () => {
    await submitCouncil(driver);

    // The launch receipt names the background job; read the job id off it.
    await driver.wait_for({ selector: 'role=listitem name~="Delegation started:"', timeoutMs: 30_000 });
    const receipt = driver.query('role=listitem name~="Delegation started:"')?.name ?? "";
    // Display text can clip mid-id (council-flow measured "...-badge" for
    // "...-badger"), so the screen yields an id PREFIX: find the record by what
    // it is, then prove the receipt names that same job.
    const shownId = /Delegation started: ([a-z]+-[a-z]+-[a-z]+)/.exec(receipt)?.[1];
    expect(shownId).toBeDefined();

    // The job carries the user's topic verbatim and runs as infrastructure.
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
    expect(launched.council?.outputContract).toBe(
      "Return advice, unresolved questions, evidence and limitations. Do not implement or accept work.",
    );

    const done = await waitForDelegation(
      cliHome,
      (r) => r.id === jobId && r.status === "complete",
      60_000,
      `${jobId} complete`,
    );
    const plan = done.councilTrace?.debatePlan;
    // The leader's pick drove the plan — not the generic fallback plan
    // (debate-planner.ts FALLBACK_PLAN: kind "decision", intentSummary
    // "(planner unavailable — using generic stances)", stances "Primary
    // Analyst"/"Critical Reviewer").
    expect(plan?.outputShape?.kind).toBe("implementation_plan");
    expect(plan?.intentSummary).toBe(
      "Add an E2E harness spec proving the council intent gate renders before any debate spend.",
    );
    expect((plan?.stances ?? []).map((s) => s.name)).toEqual(
      expect.arrayContaining(["Primary Engineer", "Skeptical Reviewer"]),
    );

    // The user was never interrupted: no askcard opened at any point of the
    // launch → debate → delivery cycle, and the composer is still usable.
    await waitForDelegation(
      cliHome,
      (r) => r.id === jobId && r.deliveredVersion === done.resultVersion,
      30_000,
      `${jobId} delivered`,
    );
    expect(driver.last_event("askcard-open")).toBeNull();
    expect(driver.query("id=askcard")).toBeNull();
    expect(driver.query("role=textbox")?.role).toBe("textbox");
  }, 150_000);
});

// The S1 launch card itself is retained code: it still runs for an
// infrastructure-role Agent (the role the in-process council lifecycle runs
// for since b014c9b9). Its original assertions are kept unchanged here, driven
// through the test-only role entry b014c9b9 added for the retained lifecycle
// (helpers.ts infrastructureRoleSpawn).
describe("council intent gate + plan card — retained lifecycle (infrastructure role)", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let greenfield: string;

  beforeAll(async () => {
    greenfield = mkdtempSync(join(tmpdir(), "council-plan-gate-infra-"));
    const infra = infrastructureRoleSpawn();
    const ctx = await spawnHarness({
      entry: infra.entry,
      extraArgs: ["-k", MOCK_PROVIDER_KEY, "-m", "deepseek-v4-flash"],
      env: { ...infra.env, ...COUNCIL_ENV, MUONROI_CLI_HOME: join(greenfield, ".muonroi-cli") },
      fixturesDir: FIXTURES_DIR,
      cwd: greenfield,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ event: "input-ready", timeoutMs: 60_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    removeTempCwd(greenfield);
  });

  it("the launch card leads with the intent options", async () => {
    await submitCouncil(driver);

    // The S1 launch configurator (council/index.ts) is the FIRST askcard-open
    // in this run: the clarifier asks zero questions (the fixture answers it
    // with non-JSON text) so the spec is judged ready and the preflight approve
    // card auto-approves (preflight.ts only emits its own askcard-open when NOT
    // auto-approved).
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
  }, 90_000);
});
