import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";

it.each([
  "1",
  "0",
])("shows workers, background plan council and terminal counts with council surface=%s", async (surface) => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-worker-rail-"));
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/worker-rail-entry.ts"),
    cwd: home,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--agent-cols", "150", "--agent-rows", "50"],
    env: {
      MUONROI_WORKER_RAIL_HOME: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_COUNCIL_SURFACE: surface,
      MUONROI_CONTEXT_RAIL: "1",
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_ROUTER_SUB_SESSION: "0",
      MUONROI_BACKGROUND_AUTOWAKE: "0",
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    await ctx.driver.wait_for({ selector: "id=agent-rail-activities props.running=3", timeoutMs: 10_000 });
    expect(ctx.driver.queryAll("id=rail-agent-steady-amber-fox")).toHaveLength(1);
    expect(ctx.driver.queryAll("id=rail-agent-clever-silver-panda")).toHaveLength(1);
    // Check actual rendered cells, not just semantic registration of invisible nodes.
    await ctx.driver.wait_for({ visualText: "Agents (3 running)", timeoutMs: 10_000 });
    expect(ctx.driver.render_visual()).toContain("Repo survey");
    expect(ctx.driver.render_visual()).toContain("Docs survey");
    expect(ctx.driver.query("id=rail-agent-keen-emerald-badger")?.name).toBe("council Flow plan review");
    await ctx.driver.wait_for({ visualText: "Flow plan", timeoutMs: 5_000 });

    const dir = join(home, ".muonroi-cli", "delegations", "rail-fixture");
    for (const [id, status] of [
      ["steady-amber-fox", "complete"],
      ["clever-silver-panda", "error"],
    ]) {
      const path = join(dir, `${id}.json`);
      const record = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(
        path,
        JSON.stringify({ ...record, status, summary: `${id} survey result`, notifiedAt: new Date().toISOString() }),
      );
    }
    await ctx.driver.wait_for({ selector: "id=agent-rail-activities props.running=1", timeoutMs: 10_000 });
    expect(ctx.driver.query("id=agent-rail-activities")?.props).toMatchObject({ count: 3, done: 1, failed: 1 });
    expect(ctx.driver.query("id=rail-agent-keen-emerald-badger")?.state).toBe("running");
    expect(ctx.driver.query("id=rail-agent-steady-amber-fox")).toBeNull();
    await ctx.driver.wait_for({ visualText: "1 done", timeoutMs: 10_000 });

    const reviewPath = join(dir, "keen-emerald-badger.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    writeFileSync(
      reviewPath,
      JSON.stringify({
        ...review,
        status: "complete",
        summary: "Plan review result",
        notifiedAt: new Date().toISOString(),
      }),
    );
    await ctx.driver.wait_for({ selector: "id=agent-rail-activities props.running=0", timeoutMs: 10_000 });
    expect(ctx.driver.query("id=agent-rail-activities")?.props).toMatchObject({ count: 3, done: 2, failed: 1 });

    ctx.driver.type("/");
    await ctx.driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    for (const ch of "jobs") ctx.driver.type(ch);
    await expect.poll(() => ctx.driver.query("id=slash-item-jobs")?.selected, { timeout: 5_000 }).toBe(true);
    const modalSettled = ctx.driver.wait_for({ idle: true, timeoutMs: 5_000 });
    ctx.driver.press("Enter");
    await modalSettled;
    await ctx.driver.wait_for({ selector: "id=jobs-modal props.count=3", timeoutMs: 10_000 });
    // Navigate after the modal owns input; this also exercises its live rows.
    ctx.driver.press("Down");
    await expect.poll(() => ctx.driver.query("id=job-clever-silver-panda")?.selected, { timeout: 5_000 }).toBe(true);
    await ctx.driver.wait_for({ visualText: "Background jobs", timeoutMs: 5_000 });
    expect(ctx.driver.query("id=job-steady-amber-fox")?.state).toBe("done");
    expect(ctx.driver.query("id=job-clever-silver-panda")?.state).toBe("failed");
    expect(ctx.driver.query("id=job-keen-emerald-badger")?.state).toBe("done");
    await ctx.driver.wait_for({ visualText: "Flow plan review", timeoutMs: 5_000 });
    const closed = ctx.driver.wait_for({ idle: true, timeoutMs: 5_000 });
    ctx.driver.press("Escape");
    await closed;
    await expect.poll(() => ctx.driver.query("id=jobs-modal"), { timeout: 5_000 }).toBeNull();
  } catch (err) {
    console.error(
      `Worker rail fixture surface=${surface}: ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_text()}\n${ctx.driver.render_visual()}`,
    );
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((resolveExit) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) resolveExit();
      else ctx.proc.once("exit", () => resolveExit());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/worker-rail.spec.ts");
  }
}, 120_000);
