/**
 * rail-agents.spec.ts
 *
 * A background job is really in the background:
 *   1. The agent's turn ends while the job is still running (the composer is
 *      free), and the rail row says `running` — not the green check the start
 *      result used to earn.
 *   2. When the job exits, its row turns `done`, and the agent is resumed with
 *      the result without the user typing anything.
 *
 * The fixture's shell sleeps a few seconds so the running state is observable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe.skipIf(process.platform === "win32")("background job in the Agents rail E2E", () => {
  let ctx: Awaited<ReturnType<typeof spawnHarness>>;
  let cwd: string;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "muonroi-rail-agents-"));
    ctx = await spawnHarness({ cwd, fixturesDir: resolve("tests/harness/fixtures/llm/rail-agents") });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 60_000);

  afterAll(() => {
    ctx?.cleanup();
    try {
      if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      console.warn(`[rail-agents.spec] temp cwd cleanup failed (leaked ${cwd}): ${(err as Error)?.message}`);
    }
  });

  it("frees the turn while the job runs, then marks it done and resumes the agent", async () => {
    ctx.driver.type("start the job in the background");
    ctx.driver.press("Enter");

    // The turn ends with the job still running.
    await ctx.driver.wait_for({ selector: "id=rail-agent-c1 state=running", timeoutMs: 60_000 });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    expect(ctx.driver.query("id=rail-agent-c1")?.state).toBe("running");

    // The job exits: the row turns done and the agent picks the result up.
    await ctx.driver.wait_for({ selector: "id=rail-agent-c1 state=done", timeoutMs: 30_000 });
    await ctx.driver.wait_for({ selector: 'role=listitem name~="RESUMED-AFTER-JOB"', timeoutMs: 60_000 });
  }, 180_000);
});
