/**
 * compact-progress.spec.ts
 *
 * /compact used to await two LLM passes with no UI at all — a minute of frozen
 * screen. This asserts the progress card is real: it mounts while the run is in
 * flight, carries a stage + percent from the pipeline, and is gone when the run
 * ends (never left behind claiming work that finished).
 *
 * The fixture sets `chunkDelayMs` so the in-flight state is observable; with an
 * instant mock the card is created and torn down inside one frame.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const STAGES = ["artifacts", "extract", "snapshot", "compress", "done"];

describe("/compact progress card E2E", () => {
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let cwd: string;

  beforeAll(async () => {
    // A throwaway cwd: /compact writes .muonroi-flow/history into it.
    cwd = mkdtempSync(join(tmpdir(), "muonroi-compact-"));
    ctx = await spawnHarness({ cwd, fixturesDir: resolve("tests/harness/fixtures/llm/compact") });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
    // Warm-up turn: pay the one-time cold dynamic-import cost here so the
    // /compact turn below is not racing module loading. Same guard as
    // scroll-lock.spec.
    ctx.driver.type("warmup");
    ctx.driver.press("Enter");
    await ctx.driver.wait_for({ idle: true, timeoutMs: 150_000 });
  }, 210_000);

  afterAll(() => {
    ctx?.cleanup();
    if (!cwd) return;
    try {
      // Windows holds the child's SQLite/flow handles briefly after kill; retry
      // rather than fail an otherwise-green suite on a temp-dir unlink.
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      console.warn(`[compact-progress.spec] temp cwd cleanup failed (leaked ${cwd}): ${(err as Error)?.message}`);
    }
  });

  it("shows a live stage + percent while compaction runs, and retires the card when it ends", async () => {
    ctx.driver.type("/compact keep the greeting");
    ctx.driver.press("Enter");

    await ctx.driver.wait_for({ selector: "id=compact-progress", timeoutMs: 20_000 });
    const card = ctx.driver.query("id=compact-progress");
    expect(card).not.toBeNull();

    // The stage comes from the compaction pipeline, not from a timer.
    expect(STAGES).toContain(card?.state);
    // Percent is surfaced for the harness AND rendered on screen.
    expect(card?.value).toMatch(/^\d{1,3}%$/);
    const pct = Number((card?.value ?? "0%").replace("%", ""));
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
    // The label is what the user reads — it must name the step, not be blank.
    expect((card?.name ?? "").trim().length).toBeGreaterThan(0);

    // When the run ends the card must disappear rather than linger at its last
    // percent, and the outcome line takes its place.
    await ctx.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    expect(ctx.driver.query("id=compact-progress")).toBeNull();
  }, 90_000);
});
