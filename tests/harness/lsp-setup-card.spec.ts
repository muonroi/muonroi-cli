/**
 * lsp-setup-card.spec.ts
 *
 * E2E: `/lsp setup` opens the inline multi-select "which languages do you work
 * in?" card (id=lsp-setup-card), Space toggles a language, Esc snoozes.
 *
 * Note on the boot-time nudge: index.ts only evaluates the LSP nudge on an
 * INTERACTIVE boot (`process.stdin.isTTY`), which is false under the harness's
 * piped stdio — so this spec drives the explicit `/lsp setup` path. The nudge's
 * snooze logic is unit-covered in src/lsp/__tests__/lsp-setup-onboarding.test.ts.
 *
 * Setup: fresh temp cwd (no detectable project languages → nothing pre-selected,
 * so the Space-toggle assertion starts from a known unselected state).
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/lsp-setup-card.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("LSP setup card E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muonroi-lsp-setup-home-"));

    const ctx = await spawnHarness({
      cwd: home,
      env: { MUONROI_NO_SHELL_HOLD: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // Mount guard: React up before driving the slash command.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("`/lsp setup` opens the language picker as a modal", async () => {
    driver.type("/lsp setup");
    driver.press("Enter");
    await driver.wait_for({ selector: "id=lsp-setup-card", timeoutMs: 20_000 });
    const card = driver.query("id=lsp-setup-card");
    expect(card).not.toBeNull();
    expect(card?.isModal).toBe(true);
  });

  it("lists every built-in language server as a pickable row", async () => {
    await driver.wait_for({ selector: "id=lsp-setup-langs", timeoutMs: 5_000 });
    const rows = driver.queryAll("id*=lsp-setup-lang-");
    // 10 built-in servers (typescript, pyright, gopls, rust-analyzer, bash,
    // yaml, clangd, jdtls, csharp-ls, sourcekit-lsp) — derived from builtins.ts.
    expect(rows.length).toBe(10);
    expect(driver.query("id=lsp-setup-lang-typescript")).not.toBeNull();
    expect(driver.query("id=lsp-setup-lang-gopls")).not.toBeNull();
  });

  it("Space toggles the language under the cursor (multi-select)", async () => {
    // Fresh empty cwd → nothing detected → typescript (row 0) starts unselected.
    expect(driver.query("id=lsp-setup-lang-typescript")?.selected).not.toBe(true);

    driver.press("Space");
    await driver.wait_for({ selector: "id=lsp-setup-lang-typescript selected", timeoutMs: 5_000 });
    expect(driver.query("id=lsp-setup-lang-typescript")?.selected).toBe(true);

    // Toggle a second language — the first stays selected (multi-select, not radio).
    driver.press("Down");
    driver.press("Space");
    await driver.wait_for({ selector: "id=lsp-setup-lang-pyright selected", timeoutMs: 5_000 });
    expect(driver.query("id=lsp-setup-lang-typescript")?.selected).toBe(true);

    // Space again untoggles.
    driver.press("Space");
    const deadline = Date.now() + 5_000;
    while (driver.query("id=lsp-setup-lang-pyright")?.selected === true && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(driver.query("id=lsp-setup-lang-pyright")?.selected).not.toBe(true);
  });

  it("esc dismisses (snooze) — the card leaves the tree", async () => {
    driver.press("Escape");
    // wait_for has no "absent" condition — poll for the card leaving the tree.
    const deadline = Date.now() + 10_000;
    while (driver.query("id=lsp-setup-card") !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(driver.query("id=lsp-setup-card")).toBeNull();
  });
});
