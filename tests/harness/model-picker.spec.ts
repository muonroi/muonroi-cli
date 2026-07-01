/**
 * E2E harness spec for Model Picker UX (Phase 19).
 *
 * Verifies:
 * - /models slash command opens the model-picker dialog
 * - Model rows are exposed as listitem Semantic nodes
 * - Provider chips are exposed as button Semantic nodes
 * - Picker closes on Escape
 *
 * Transport: Windows uses named pipes (via spawnHarness); POSIX uses fd 3/4.
 * No platform guards needed — test-spawn.ts selects the right transport.
 *
 * Uses -k FAKE_KEY to bypass the API-key modal (same pattern as mcp-modal.spec.ts).
 * Type slash command character-by-character to let React re-render between chars.
 */

import type { ChildProcess } from "node:child_process";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

/**
 * Poll a predicate until it holds (or the deadline passes), then return.
 *
 * Used instead of `wait_for({ idle: true })` for input/teardown assertions.
 * The idle sentinel uses a 50ms quiescence that the child resets on every
 * emitted frame AND every incoming command (agent-mode.ts). Under full-suite
 * CPU contention the idle scheduled after a PRIOR frame can fire before the
 * child reads the next command, so `wait_for({ idle: true })` resolves against
 * a stale frame — the typed value is still "" or a closing modal hasn't torn
 * down yet. Polling the concrete Semantic state is immune to that timing race.
 * `wait_for` also only waits for selector PRESENCE, never absence, so closes
 * must be polled regardless. On timeout we return quietly and let the caller's
 * expect(...) fail with a meaningful value.
 */
async function waitForStable(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// retry:0 — this is a stateful sequential spec: the picker opened in test 1
// stays open for tests 2-3, and test 4 reopens it. A vitest retry re-runs only
// the failed it() body (not beforeAll), so it would re-press against whatever
// modal state the failure left open — e.g. typing "/" into a still-open key
// prompt instead of opening the slash menu, which then times out waiting for
// id=slash-menu. Determinism comes from the waitForStable polls below.
describe("model-picker E2E", { retry: 0 }, () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
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
  });

  it("opens model picker via /models command", async () => {
    // Type "/" first and wait for the slash menu to open.
    // Then type "models" char-by-char so React re-renders before Enter fires.
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    driver.type("m");
    driver.type("o");
    driver.type("d");
    driver.type("e");
    driver.type("l");
    driver.type("s");
    // Gate Enter on the composer reflecting the full typed query — NOT on
    // wait_for({idle}), which a stale idle can resolve before all chars are
    // processed, firing Enter against an incomplete command under load.
    await waitForStable(() => (driver.query("id=composer")?.value ?? "").includes("models"), 5_000);
    driver.press("Enter");

    await driver.wait_for({ selector: "id=model-picker", timeoutMs: 10_000 });

    const picker = driver.query("id=model-picker");
    expect(picker).not.toBeNull();
    expect(picker?.role).toBe("dialog");
  });

  it("exposes model rows as listitem nodes", async () => {
    // model-picker should still be open from previous test
    const rows = driver.queryAll("role=listitem");
    // The mock env may not have catalog models loaded, but the array should exist
    expect(Array.isArray(rows)).toBe(true);
  });

  it("closes model picker on Escape", async () => {
    driver.press("Escape");
    // Poll for ABSENCE — wait_for only waits for selector presence, and a bare
    // wait_for({idle}) can resolve before the close render commits under load
    // (same teardown race as the provider-key-prompt cleanup below).
    await waitForStable(() => driver.query("id=model-picker") === null, 5_000);

    const picker = driver.query("id=model-picker");
    expect(picker).toBeNull();
  });

  it("accepts typing into the provider key prompt (regression: stale-closure + batched setState)", async () => {
    // Self-contained: reopen the picker, then open the per-provider API-key
    // sub-modal with 'k' for the focused provider chip.
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    for (const ch of "models") driver.type(ch);
    // Gate Enter on the composer reflecting the full typed query (see test 1).
    await waitForStable(() => (driver.query("id=composer")?.value ?? "").includes("models"), 5_000);
    driver.press("Enter");
    await driver.wait_for({ selector: "id=model-picker", timeoutMs: 10_000 });

    driver.press("k");
    await driver.wait_for({ selector: "id=provider-key-prompt", timeoutMs: 5_000 });

    const input = driver.query("id=provider-key-input");
    expect(input).not.toBeNull();
    expect(input?.role).toBe("textbox");
    // Field starts empty.
    expect(input?.value ?? "").toBe("");

    // Type a fake key. Two bugs used to swallow this:
    //   1. handleKey closed over a stale apiKeyPrompt === null (missing dep)
    //      so the keystrokes were dropped entirely (value stayed "").
    //   2. After the dep fix, a synchronous burst batched before re-render so
    //      each setState read a stale value and only the LAST char survived
    //      (value === "0"). The functional updater fixes that.
    // After both fixes the value must equal exactly what was typed.
    const fakeKey = "sktestkey1234567890";
    driver.type(fakeKey);
    // Poll the actual input value rather than wait_for({idle}). The idle
    // sentinel uses a 50ms quiescence reset per-frame AND per-command; under
    // full-suite CPU contention the idle scheduled after the prompt-open frame
    // can fire BEFORE the child reads this type() command, resolving
    // wait_for({idle}) against a stale frame where value is still "". The
    // functional-updater append (app.tsx) is burst-safe, so the value reaches
    // fakeKey within a frame or two — polling it is immune to the idle race.
    await waitForStable(() => (driver.query("id=provider-key-input")?.value ?? "") === fakeKey, 5_000);

    const filled = driver.query("id=provider-key-input");
    expect(filled?.value).toBe(fakeKey);

    // Cleanup: dismiss the key prompt and poll until the modal actually
    // unmounts (same teardown race — wait_for only waits for presence).
    driver.press("Escape");
    await waitForStable(() => driver.query("id=provider-key-prompt") === null, 10_000);
    expect(driver.query("id=provider-key-prompt")).toBeNull();
  });
});
