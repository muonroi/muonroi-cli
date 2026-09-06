/**
 * council-surface.spec.ts
 *
 * E2E for the Concept 4 council surface (MUONROI_COUNCIL_SURFACE): the surface
 * reflows between a two-pane layout (≥96 cols) and a one-line council-strip
 * banner (<96 cols), and always mounts the protected `council-rail-now`
 * liveness block in two-pane mode.
 *
 * Width is set deterministically per spawn via `--agent-cols`. The surface
 * marker (`id=council-surface`) renders once the transcript has any message, so
 * each case types one line to leave the empty-state welcome screen.
 *
 * Run:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/council-surface.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

/**
 * Tear down one spawned surface.
 *
 * `proc.kill()` is asynchronous: on Windows the child still holds open handles
 * on files inside `home` (the session DB above all) for a short window after
 * the signal, and `rmSync` then throws `EPERM` — which `force: true` does NOT
 * suppress (it only swallows ENOENT). Because this runs in `afterAll`, and
 * vitest does not apply `retry` to hook failures, that EPERM failed the whole
 * suite file DETERMINISTICALLY at every retry setting.
 *
 * So: wait for the child to actually exit (bounded at 2s) before removing the
 * directory, and treat a still-failing removal as a leaked temp dir — logged,
 * never fatal. Mirrors the pattern already used in session-picker.spec.ts.
 */
async function teardownSurface(proc: ChildProcess | undefined, cleanup: (() => void) | undefined, home: string) {
  proc?.kill();
  await new Promise<void>((resolve) => {
    if (!proc) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.on("exit", done);
    proc.on("close", done);
    setTimeout(done, 2_000);
  });
  cleanup?.();
  if (!home) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (err) {
    // Not fatal: a leaked temp dir under os.tmpdir() is harmless, whereas
    // failing the hook turns a passing suite red for a teardown race.
    console.error(`[council-surface.spec] temp home cleanup failed for ${home}: ${(err as Error).message}`);
  }
}

async function bootSurface(
  cols: number,
): Promise<{ proc: ChildProcess; driver: Driver; cleanup: () => void; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "muonroi-council-surface-"));
  const ctx = await spawnHarness({
    cwd: home,
    extraArgs: [`--agent-cols=${cols}`],
    env: { MUONROI_COUNCIL_SURFACE: "1", MUONROI_NO_SHELL_HOLD: "1" },
  });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 15_000 });
  // Any message flips the transcript out of the empty-state welcome so the
  // surface marker mounts. A user message alone sets hasMessages.
  ctx.driver.type("hello council");
  ctx.driver.press("Enter");
  await ctx.driver.wait_for({ selector: "id=council-surface", timeoutMs: 15_000 });
  return { ...ctx, home };
}

describe("council surface — two-pane at ≥96 cols", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let home: string;

  beforeAll(async () => {
    ({ proc, driver, cleanup, home } = await bootSurface(100));
  }, 60_000);

  afterAll(async () => {
    await teardownSurface(proc, cleanup, home);
  });

  it("resolves layout=two-pane", () => {
    expect(driver.query("id=council-surface")?.props?.layout).toBe("two-pane");
  });

  it("mounts the sectioned rail with the protected NOW liveness block", () => {
    expect(driver.query("id=council-rail")).not.toBeNull();
    const now = driver.query("id=council-rail-now");
    expect(now).not.toBeNull();
    // Idle (no live council): the block reads 'idle', not a fake meter.
    expect(now?.props?.liveness).toBe("idle");
    expect(now?.props?.alive).toBe(false);
  });

  it("does NOT render the strip banner in two-pane mode", () => {
    expect(driver.query("id=council-strip")).toBeNull();
  });
});

describe("council surface — strip at <96 cols", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let home: string;

  beforeAll(async () => {
    ({ proc, driver, cleanup, home } = await bootSurface(80));
  }, 60_000);

  afterAll(async () => {
    await teardownSurface(proc, cleanup, home);
  });

  it("resolves layout=strip", () => {
    expect(driver.query("id=council-surface")?.props?.layout).toBe("strip");
  });

  it("collapses the rail to a one-line council-strip banner", () => {
    expect(driver.query("id=council-strip")).not.toBeNull();
    // The two-pane rail must be unmounted below the threshold.
    expect(driver.query("id=council-rail")).toBeNull();
  });
});
