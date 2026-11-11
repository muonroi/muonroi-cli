import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";

it.each([
  80, 120, 180,
])("renders a two-row footer at %i columns without losing cache, permission, warning or spend", async (cols) => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-footer-"));
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/orchestrator-status-entry.ts"),
    cwd: home,
    extraArgs: [
      "-k",
      "FAKE_KEY_FOR_TESTS",
      "-m",
      "deepseek-v4-flash",
      "--agent-cols",
      String(cols),
      "--agent-rows",
      "50",
    ],
    env: {
      MUONROI_STATUS_FIXTURE_HOME: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "id=status", timeoutMs: 60_000 });
    writeFileSync(join(home, "status-trigger.txt"), "footer");
    const receipt = join(home, "status-receipt.json");
    await expect
      .poll(() => (existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")).command : null), { timeout: 10_000 })
      .toBe("footer");
    ctx.driver.type(".");
    await ctx.driver.wait_for({ visualText: "Cache hit 52%", timeoutMs: 10_000 });
    const visual = ctx.driver.render_visual();
    const lines = visual.split("\n");
    const main = lines.findIndex((line) => line.includes("Run $2.89"));
    expect(main).toBeGreaterThanOrEqual(0);
    expect(lines[main]).toContain("Yolo");
    expect(lines[main]).toContain("DEGRADED");
    expect(lines[main + 1]).toContain("Cache hit 52%");
    expect(lines[main + 1]).toContain("Context 13%");
    expect(visual.match(/\$2\.89/g)).toHaveLength(1);
    expect(visual).not.toContain("consider /clear");
    expect(ctx.driver.query("id=status")?.value).toContain("current run input=5200000 cached=2700000");
    const evidence = resolve(".quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/footer-previews");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${cols}-columns.txt`), visual);
  } catch (err) {
    console.error(
      `Footer layout failed: ${err instanceof Error ? err.message : String(err)}\n${ctx.driver.render_visual()}`,
    );
    throw err;
  } finally {
    ctx.proc.kill();
    await new Promise<void>((done) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) done();
      else ctx.proc.once("exit", () => done());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/footer-layout.spec.ts");
  }
}, 120_000);
