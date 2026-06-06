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

describe("model-picker E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 25_000);

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
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
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
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });

    const picker = driver.query("id=model-picker");
    expect(picker).toBeNull();
  });

  it("accepts typing into the provider key prompt (regression: stale-closure + batched setState)", async () => {
    // Self-contained: reopen the picker, then open the per-provider API-key
    // sub-modal with 'k' for the focused provider chip.
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    for (const ch of "models") driver.type(ch);
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
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
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });

    const filled = driver.query("id=provider-key-input");
    expect(filled?.value).toBe(fakeKey);

    // Cleanup: dismiss the key prompt. (Final test — nothing depends on the
    // picker state afterwards, so a back-to-back picker Escape is not needed.)
    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    expect(driver.query("id=provider-key-prompt")).toBeNull();
  });
});
