import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HarnessContext, spawnHarness } from "./helpers.js";

describe("mounted wallet startup (undefined applyWalletSettings regression)", { retry: 0 }, () => {
  let ctx: HarnessContext;

  beforeAll(async () => {
    ctx = await spawnHarness();
    // Drain ANSI render output so a pipe cannot stall the child while frames use the sidechannel.
    ctx.proc.stdout?.resume();
    // An idle sentinel can precede React's first render. Require the actual composer.
    await ctx.driver.wait_for({ selector: "id=composer", timeoutMs: 15_000 });
    await ctx.driver.wait_for({ event: "input-ready", timeoutMs: 15_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.proc.kill();
    ctx?.cleanup();
  });

  it("renders the composer and registers input without a wallet callback ReferenceError", () => {
    expect(ctx.driver.query("id=composer")?.role).toBe("textbox");
    expect(ctx.driver.snapshot()?.nodes.length).toBeGreaterThan(0);
    expect(ctx.driver.last_event("input-ready")).not.toBeNull();
    expect(ctx.proc.exitCode).toBeNull();
  });
});
