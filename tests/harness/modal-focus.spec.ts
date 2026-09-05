/**
 * modal-focus.spec.ts
 *
 * Goal: assert composer focus is observable through the harness and document
 * the remaining work for a true modal-Esc-restore scenario.
 *
 * History:
 *   The original investigation comment claimed no <Semantic> nodes were
 *   wired. That was true at the time. Commit 8f55bbb landed
 *   `<Semantic id="composer" role="textbox" focus={...}>` around
 *   `src/ui/app.tsx:6326`, so the first todo is no longer accurate — focus
 *   IS observable when no blocking modal (model picker, sandbox picker,
 *   api-key modal, etc.) is open.
 *
 *   The second todo (dismissible dialog -> Esc -> focus returns to composer)
 *   still has no <Semantic role="dialog" isModal> in any picker, so it stays
 *   as `it.todo`.
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("modal focus E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    // Pre-seed a fake API key so the api-key modal does not steal focus from
    // the composer. The composer's focus prop checks !showApiKeyModal among
    // the gating conditions (src/ui/app.tsx:6336-6345).
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      idleTimeoutMs: 20_000,
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    await driver.wait_for({ selector: "id=composer", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("composer reports focus=true when no blocking modal is open", () => {
    const composer = driver.query("id=composer");
    expect(composer).not.toBeNull();
    expect(composer?.role).toBe("textbox");
    // Focus mirrors the app-level gating conditions in src/ui/app.tsx:6336.
    // With no model picker, sandbox picker, wallet picker, plan questions,
    // api-key modal, or blockPrompt active, focus must be true.
    expect(composer?.focus).toBe(true);
  });

  // TODO: dismissible modal — depends on <Semantic role="dialog" isModal> wired to a real modal (e.g. model picker) in src/ui/; remove .todo when wired
  it.todo(
    "/council does not open a modal picker: it calls agent.runCouncilRound() directly; there is no dismissible dialog to press Esc on in the harness",
  );

  // --- tui.focus honesty (2026-09-05) -------------------------------------
  // Appended BELOW the it.todo on purpose: scripts/.harness-skips-allow.json
  // pins that todo by file:line, so new cases must not shift it.
  //
  // `driver.focus()` dispatches `__focus__:<id>`, which the OpenTUI input
  // bridge drops on purpose (input-bridge.tsx: focus routing is owned by
  // individual components). The MCP `tui.focus` tool nevertheless answered the
  // bare string "ok" for every selector, so a driver could not tell a
  // successful recovery from a no-op — which is how a live /ideal run stuck
  // between two stacked modals became undiagnosable. `focus_verified` reports
  // what actually happened.

  it("focus_verified reports ok for a node that already holds focus", async () => {
    const outcome = await driver.focus_verified("id=composer");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.id).toBe("composer");
      expect(outcome.alreadyFocused).toBe(true);
    }
  });

  it("focus_verified FAILS on a node that cannot take focus (was a false ok)", async () => {
    // The status bar is real, unique and unfocusable — exactly the class of
    // selector that used to answer "ok" while moving nothing.
    expect(driver.query("id=status")).not.toBeNull();
    const outcome = await driver.focus_verified("id=status", 300);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("not_focusable");
      expect(outcome.id).toBe("status");
      expect(outcome.message).toContain("press");
    }
    // And focus did not silently move: the composer still owns it.
    expect(driver.query("id=composer")?.focus).toBe(true);
  });

  it("focus_verified reports no_match instead of pretending to succeed", async () => {
    const outcome = await driver.focus_verified("id=definitely-not-a-node", 100);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("no_match");
  });
});
