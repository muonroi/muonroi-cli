import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";

it("keeps the mounted Orchestrator label on the root model after compaction and auxiliary routing", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-root-status-"));
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/orchestrator-status-entry.ts"),
    cwd: home,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--agent-cols", "180", "--agent-rows", "50"],
    env: {
      MUONROI_STATUS_FIXTURE_HOME: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "id=status", timeoutMs: 60_000 });
    const receipt = join(home, "status-receipt.json");
    for (const command of ["ready", "compaction", "router", "downgrade"]) {
      writeFileSync(join(home, "status-trigger.txt"), command);
      await expect
        .poll(() => (existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")).command : null), {
          timeout: 10_000,
        })
        .toBe(command);
      const result = JSON.parse(readFileSync(receipt, "utf8"));
      expect(result.error).toBeUndefined();
      expect(result.rootModel).not.toBe(result.helper);
      expect(result.displayed.model).toBe(result.rootModel);
      expect(result.displayed.provider).toBe(result.rootProvider);
      // Exercise an ordinary user input render after each asynchronous update.
      ctx.driver.type(".");
      await ctx.driver.wait_for({
        visualText: `Orchestrator ${result.rootProvider}/${result.rootModel}`,
        timeoutMs: 10_000,
      });
      expect(ctx.driver.query("id=status")?.value).toContain(`${result.rootProvider}/${result.rootModel}`);
      if (command === "compaction") await ctx.driver.wait_for({ visualText: "↑777", timeoutMs: 10_000 });
    }
  } catch (err) {
    const receipt = join(home, "status-receipt.json");
    if (existsSync(receipt)) console.error("Last status receipt", readFileSync(receipt, "utf8"));
    console.error(
      `Orchestrator status fixture failed: ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_visual()}`,
    );
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((done) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) done();
      else ctx.proc.once("exit", () => done());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/orchestrator-status.spec.ts");
  }
}, 120_000);
