/**
 * ideal-init-new-flow.spec.ts — Real-user E2E walkthrough of `/ideal` halt
 * recovery → Init new → 3-step form.
 *
 * What this spec covers (drives the TUI as a real user would):
 *   1. /ideal halts with no verify recipe (synthetic via --inject-halt).
 *   2. The HaltRecoveryCard renders with 3 options; user selects "Init new".
 *   3. The InitNewFormCard opens at step="name".
 *   4. User types project name → step="fe-stack".
 *   5. User confirms FE stack → step="bb-template".
 *   6. The 3 BB template options match the NuGet packages published in
 *      2026-05-16 (BaseTemplate / Modular / Microservices) with the correct
 *      shortNames (mr-base-sln / mr-mod-sln / mr-micro-sln).
 *   7. Arrow keys move the selection between the 3 BB templates.
 *
 * What this spec INTENTIONALLY does NOT do:
 *   - Press Enter on the bb-template step. That would invoke real `dotnet new`
 *     which downloads NuGet packages and writes to disk. The scaffold runner
 *     itself is covered by tests/harness/init-new-bb-template.spec.ts (mocked).
 *
 * Test trigger: --inject-halt (synthetic seam — see src/index.ts + src/ui/app.tsx).
 */
import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

/**
 * Poll until `predicate()` returns true. Used to wait for state that depends
 * on multiple Semantic register/unregister cycles to settle (e.g. when a form
 * step transitions and the old step's options must fully unregister before
 * we can assert their absence). `driver.wait_for` only waits for selector
 * PRESENCE, not absence, so polling is needed here.
 */
async function waitForStable(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Timeout — let the caller's assertion fail with a meaningful message.
}

/*
 * Root cause for the prior skip (FIXED 2026-05-16): src/ui/app.tsx gated the
 * "messages" branch (which contains <Semantic id="log">, <HaltRecoveryCard>,
 * <InitNewFormCard>, etc.) on `hasMessages = messages.length > 0 ||
 * streamContent || isProcessing`. With --inject-halt the halt state was set
 * but no message had arrived → home branch rendered → semantic tree missing.
 * Fix: include activeHaltCard / initNewForm / pointToExistingForm /
 * councilProgress in the hasMessages predicate. Spec re-enabled.
 */
// retry:0 — this is a stateful sequential walkthrough: each it() advances the
// form/selection via key presses, so a vitest retry would re-press against the
// already-advanced state and corrupt the sequence (it can never recover a flake
// here). Determinism comes from the waitForStable polls in each step instead.
describe("/ideal halt → init-new → BB template picker E2E", { retry: 0 }, () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash", "--inject-halt"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  // ---------------------------------------------------------------------------
  // Stage 1 — Halt card visible, "Init new" highlighted, press Enter
  // ---------------------------------------------------------------------------

  it("stage 1: halt card renders with Init new selected by default", async () => {
    await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 8_000 });
    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts).toHaveLength(3);
    expect(opts[0]?.name).toBe("Init new project");
    expect(opts[0]?.selected).toBe(true);
  });

  it("stage 1: Enter on Init new dismisses halt card and opens init-new form", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "id=init-new-form", timeoutMs: 8_000 });
    expect(driver.query("id=ideal-halt-card")).toBeNull();
    const form = driver.query("id=init-new-form");
    expect(form?.role).toBe("dialog");
    expect(form?.name).toBe("Init new project");
  });

  // ---------------------------------------------------------------------------
  // Stage 2 — Step 1: project name
  // ---------------------------------------------------------------------------

  it("stage 2: form opens at step=name (cursor on name input)", async () => {
    // FE options not yet visible at step=name
    const feOpts = driver.queryAll("id=init-new-form >> id^=init-fe-option-");
    expect(feOpts.length).toBe(0);
    // BB options not yet visible either
    const bbOpts = driver.queryAll("id=init-new-form >> id^=init-bb-option-");
    expect(bbOpts.length).toBe(0);
  });

  it("stage 2: typing project name + Enter advances to fe-stack step", async () => {
    driver.type("TodoApp");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    driver.press("Enter");
    // After Enter, fe-stack options appear
    await driver.wait_for({ selector: "id=init-new-form >> id=init-fe-option-react", timeoutMs: 5_000 });
    const feOpts = driver.queryAll("id=init-new-form >> id^=init-fe-option-");
    expect(feOpts.length).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Stage 3 — Step 2: FE stack picker
  // ---------------------------------------------------------------------------

  it("stage 3: FE stack options show react/angular/none with react selected by default", () => {
    const opts = driver.queryAll("id=init-new-form >> id^=init-fe-option-");
    const labels = opts.map((o) => o.name);
    expect(labels).toContain("React");
    expect(labels).toContain("Angular");
    expect(labels).toContain("None");
    const reactOpt = driver.query("id=init-new-form >> id=init-fe-option-react");
    expect(reactOpt?.selected).toBe(true);
  });

  it("stage 3: Enter on FE stack advances to bb-template step", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "id=init-new-form >> id=init-bb-option-mr-base-sln", timeoutMs: 5_000 });
    // FE options should be unregistered after the step transition.
    const feOpts = driver.queryAll("id=init-new-form >> id^=init-fe-option-");
    expect(feOpts.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Stage 4 — Step 3: BB template picker (the main payload of this spec)
  // ---------------------------------------------------------------------------

  it("stage 4: exactly 3 BB template options visible with correct shortNames", () => {
    const opts = driver.queryAll("id=init-new-form >> id^=init-bb-option-");
    expect(opts).toHaveLength(3);

    // shortName is encoded in the semantic id. Verify each one matches what
    // the published NuGet packages register (per 2026-05-16 verification).
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("init-bb-option-mr-base-sln");
    expect(ids).toContain("init-bb-option-mr-mod-sln");
    expect(ids).toContain("init-bb-option-mr-micro-sln");
  });

  it("stage 4: BB template labels are user-readable (BaseTemplate / Modular / Microservices)", () => {
    const labels = driver.queryAll("id=init-new-form >> id^=init-bb-option-").map((o) => o.name);
    expect(labels).toContain("BaseTemplate");
    expect(labels).toContain("Modular");
    expect(labels).toContain("Microservices");
  });

  it("stage 4: BaseTemplate is selected by default", () => {
    const base = driver.query("id=init-new-form >> id=init-bb-option-mr-base-sln");
    expect(base?.selected).toBe(true);
    const modular = driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln");
    expect(modular?.selected).toBeFalsy();
    const micro = driver.query("id=init-new-form >> id=init-bb-option-mr-micro-sln");
    expect(micro?.selected).toBeFalsy();
  });

  it("stage 4: Down arrow moves selection BaseTemplate → Modular", async () => {
    driver.press("Down");
    // wait_for({idle}) can return before React commits the selection state
    // setter — poll for the actual flag transfer, matching the sibling arrow
    // tests below. (Without this, the assert races the re-render: observed
    // `base.selected` still true / `mod.selected` undefined intermittently.)
    await waitForStable(
      () => driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln")?.selected === true,
      3_000,
    );
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-base-sln")?.selected).toBeFalsy();
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln")?.selected).toBe(true);
  });

  it("stage 4: Down arrow again moves selection Modular → Microservices", async () => {
    driver.press("Down");
    // wait_for({idle}) can return before React commits the state setter —
    // use the same waitForStable pattern as the Up arrow test below.
    await waitForStable(
      () => driver.query("id=init-new-form >> id=init-bb-option-mr-micro-sln")?.selected === true,
      3_000,
    );
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln")?.selected).toBeFalsy();
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-micro-sln")?.selected).toBe(true);
  });

  it("stage 4: Up arrow restores selection Microservices → Modular", async () => {
    driver.press("Up");
    // Wait for the selected flag to actually transfer back to Modular —
    // wait_for({idle}) can return before React commits the state setter.
    await waitForStable(
      () => driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln")?.selected === true,
      3_000,
    );
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-mod-sln")?.selected).toBe(true);
    expect(driver.query("id=init-new-form >> id=init-bb-option-mr-micro-sln")?.selected).toBeFalsy();
  });

  // NOTE: Do NOT press Enter here — that would invoke real `dotnet new` against
  // NuGet and write to disk. The scaffold runner is covered by
  // tests/harness/init-new-bb-template.spec.ts (mocked spawnSync).
  //
  // Dismiss the form to leave a clean state for afterAll.
  it("stage 4: Escape returns from bb-template to fe-stack step", async () => {
    driver.press("Escape");
    // Escape on bb-template step is wired to go BACK to fe-stack (not close
    // the form) — see app.tsx bb-template Escape handler.
    // Wait for bb-options to fully unregister and fe-options to mount.
    await waitForStable(
      () =>
        driver.queryAll("id=init-new-form >> id^=init-bb-option-").length === 0 &&
        driver.queryAll("id=init-new-form >> id^=init-fe-option-").length === 3,
      3_000,
    );
    const bbOpts = driver.queryAll("id=init-new-form >> id^=init-bb-option-");
    const feOpts = driver.queryAll("id=init-new-form >> id^=init-fe-option-");
    expect(bbOpts.length).toBe(0);
    expect(feOpts.length).toBe(3);
  });
});
