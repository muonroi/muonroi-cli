/**
 * scroll-lock.spec.ts
 *
 * Covers MUONROI_SCROLL_LOCK (P0 of the debate two-pane redesign):
 * - `id=log` exposes boolean `props.locked` + `props.newSinceLock`.
 * - Default state is unlocked (pinned to the live tail).
 * - Scrolling up (PageUp) while content exists flips `locked` true and surfaces
 *   the `id=jump-to-latest` pill.
 * - End re-pins and retires the pill.
 *
 * Scroll assertions read a boolean Semantic prop (`props.locked`) rather than a
 * raw scroll offset — `scrollTop` is stripped from frames by determinism.spec
 * for flake-resistance, so numeric offsets are not observable via the driver.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("scroll-lock E2E", () => {
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;

  beforeAll(async () => {
    ctx = await spawnHarness({ env: { MUONROI_SCROLL_LOCK: "1" } });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    // Mount guard: idle can fire before React mounts (seq=0 empty frame race);
    // typing then drops the keys and `id=log` never appears. Same guard as
    // cost-leak-tui-smoke / error-states.
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
    // Warm-up turn — front-load the one-time cold cost. The FIRST real
    // processMessage lazily dynamic-imports the orchestrator / PIL / tool-engine
    // modules; on a cold machine under full-suite serial contention that cold
    // disk read has been measured to spike a single mock turn past 90s
    // (flake 2026-07-06, root-caused 2026-07-07: warm turns idle in <1s, the PIL
    // classifier never fires — pure spawn/import latency, not routing). Paying
    // it here in setup with a generous budget keeps every test-body turn warm
    // and deterministic; a genuine hang still fails the boot/test timeout.
    ctx.driver.type("warmup");
    ctx.driver.press("Enter");
    await ctx.driver.wait_for({ idle: true, timeoutMs: 150_000 });
  }, 210_000);

  afterAll(() => ctx?.cleanup());

  it("exposes an unlocked log once content exists", async () => {
    // The log Semantic only mounts once the transcript has content.
    ctx.driver.type("hello world");
    ctx.driver.press("Enter");
    await ctx.driver.wait_for({ selector: "id=log", timeoutMs: 10_000 });
    const log = ctx.driver.query("id=log");
    expect(log).not.toBeNull();
    expect(log?.props?.locked).toBe(false);
    expect(ctx.driver.query("id=jump-to-latest")).toBeNull();
  }, 15_000);

  it("locks on scroll-up and re-pins on End", async () => {
    // Fill the transcript so there is history to scroll away from. The cold
    // import spike is already paid by the beforeAll warm-up turn, so each of
    // these turns runs warm (<1s in isolation); 30s is pure headroom for
    // ordinary full-suite serial contention.
    for (let i = 0; i < 8; i++) {
      ctx.driver.type(`fill message ${i} line one line two line three line four`);
      ctx.driver.press("Enter");
      await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    }

    // Scroll up: composer is empty, so PageUp drives the transcript. The
    // jump-to-latest pill renders only while locked, so waiting on its selector
    // proves the lock engaged.
    ctx.driver.press("PageUp");
    ctx.driver.press("PageUp");
    await ctx.driver.wait_for({ selector: "id=jump-to-latest", timeoutMs: 5_000 });
    expect(ctx.driver.query("id=log")?.props?.locked).toBe(true);

    // End re-pins and retires the pill.
    ctx.driver.press("End");
    await ctx.driver.wait_for({ idle: true, timeoutMs: 5_000 });
    expect(ctx.driver.query("id=jump-to-latest")).toBeNull();
    expect(ctx.driver.query("id=log")?.props?.locked).toBe(false);
  }, 300_000);
});
