/**
 * exit-clean.spec.ts — `/exit` ends the process, promptly and cleanly.
 *
 * Two independent defects made `/exit` + Enter fail to end an agent-mode TUI
 * (measured on Windows, 32 baseline runs: 4 still alive after the wait, 20
 * killed by a segfault, only 8 clean):
 *
 * 1. Stale slash-menu closure (src/ui/slash/menu-items.ts
 *    resolveLiveSlashSelection). `driver.type("/exit")` + Enter arrive in one
 *    input batch, so Enter ran against the PREVIOUS render's menu state —
 *    query "" — and selected item 0 of the unfiltered list, `/permissions`.
 *    onExit was never called, hence "nothing in the debug log after /exit".
 *    Same bug in interactive mode when "/exit\r" arrives in one stdin chunk
 *    (a paste, a fast typist): 3/3 runs did not exit before the fix.
 *
 * 2. Use-after-free on teardown (packages/agent-harness-opentui/src/
 *    visual-capture.ts). After renderer.destroy() freed the native buffers,
 *    the 60fps harness poll still called getSpanLines() on them → Bun
 *    "panic: Segmentation fault" in opentui.dll, exit code 3.
 *
 * The bound: after the fix, /exit-to-'exit' took 114-167 ms after a chat turn
 * (6 runs) — the cleanup steps themselves settle in 3-30 ms. EXIT_BOUND_MS
 * leaves >25x headroom for a loaded CI box while staying far below the
 * observed hang (alive after 30 s).
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";

const EXIT_BOUND_MS = 5_000;

type Exit = { code: number | null; signal: NodeJS.Signals | null; elapsedMs: number } | null;

function waitForExit(proc: ChildProcess, startedAt: number, timeoutMs: number): Promise<Exit> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode, elapsedMs: 0 });
  }
  return new Promise<Exit>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, elapsedMs: Date.now() - startedAt });
    });
  });
}

describe("/exit ends the process", () => {
  let proc: ChildProcess | undefined;
  let cleanup: (() => void) | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      await waitForExit(proc, Date.now(), 15_000);
    }
    cleanup?.();
    if (cwd) bestEffortRemoveSync(cwd, "tests/harness/exit-clean.spec.ts");
    proc = undefined;
    cleanup = undefined;
    cwd = undefined;
  });

  async function boot(): Promise<{ driver: Driver; stderr: () => string }> {
    // Greenfield temp cwd: no repo scan, deterministic boot (see CLAUDE.md caveat 2).
    cwd = mkdtempSync(join(tmpdir(), "muonroi-exit-clean-"));
    const ctx = await spawnHarness({ cwd });
    proc = ctx.proc;
    cleanup = ctx.cleanup;
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += d.toString();
    });
    // input-ready, not idle: idle can fire on the pre-mount frame, before the
    // input bridge exists (agent-mode.ts onCommand).
    await ctx.driver.wait_for({ event: "input-ready", timeoutMs: 30_000 });
    return { driver: ctx.driver, stderr: () => err };
  }

  async function exitAndMeasure(driver: Driver, stderr: () => string): Promise<void> {
    const startedAt = Date.now();
    const exited = waitForExit(proc as ChildProcess, startedAt, EXIT_BOUND_MS);
    driver.type("/exit");
    driver.press("Enter");
    const result = await exited;
    process.stderr.write(
      `[exit-clean] /exit -> exit: ${result ? `${result.elapsedMs}ms code=${result.code}` : `alive >${EXIT_BOUND_MS}ms`}\n`,
    );
    // Alive past the bound = the hang (typically /exit mis-routed to another
    // slash command — the composer then shows that command's output).
    expect(result, `still alive ${EXIT_BOUND_MS}ms after /exit`).not.toBeNull();
    // Exit code 3 + "panic" on stderr = the post-destroy use-after-free.
    expect(stderr()).not.toMatch(/panic\(main thread\)|Segmentation fault/);
    expect(result?.code).toBe(0);
  }

  it("after a chat turn, /exit+Enter typed in one burst exits with code 0 within the bound", async () => {
    const { driver, stderr } = await boot();
    driver.type("hello there");
    driver.press("Enter");
    await driver.wait_for({ selector: "id=msg-1", timeoutMs: 30_000 });
    await driver.wait_for({ idle: true, timeoutMs: 30_000 });
    await exitAndMeasure(driver, stderr);
  }, 90_000);

  it("right after boot, /exit+Enter exits with code 0 within the bound", async () => {
    const { driver, stderr } = await boot();
    await exitAndMeasure(driver, stderr);
  }, 90_000);
});
