import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";

it("runs Git and a source snapshot from the mounted Bun TUI without a provider request", async () => {
  const home = mkdtempSync(join(tmpdir(), "muonroi-git-host-")),
    target = join(home, "workspace");
  mkdirSync(target);
  execFileSync("git", ["init", "-q", target], { windowsHide: true });
  writeFileSync(join(target, "source.ts"), "export const value = 1;");
  const probeTarget = process.env.MUONROI_GIT_READONLY_TARGET ?? target;
  const ctx = await spawnHarness({
    entry: resolve("tests/harness/fixtures/git-snapshot-entry.ts"),
    cwd: home,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--agent-cols", "120", "--agent-rows", "35"],
    env: {
      MUONROI_GIT_FIXTURE_HOME: home,
      MUONROI_GIT_FIXTURE_TARGET: probeTarget,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
    },
  });
  try {
    await ctx.driver.wait_for({ selector: "id=status", timeoutMs: 60_000 });
    const results: Array<Record<string, unknown>> = [];
    for (const command of ["async-git", "snapshot"]) {
      writeFileSync(join(home, "git-trigger.txt"), command);
      const receipt = join(home, `git-${command}.json`);
      await expect.poll(() => existsSync(receipt), { timeout: 45_000 }).toBe(true);
      results.push(JSON.parse(readFileSync(receipt, "utf8")));
    }
    console.log("Mounted Git snapshot receipts", JSON.stringify(results));
    if (process.env.MUONROI_GIT_HOST_REPORT)
      writeFileSync(process.env.MUONROI_GIT_HOST_REPORT, JSON.stringify(results, null, 2));
    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.elapsedMs).toBeLessThan(10000);
    }
  } finally {
    ctx.proc.kill();
    await new Promise<void>((done) => {
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) done();
      else ctx.proc.once("exit", () => done());
    });
    ctx.cleanup();
    bestEffortRemoveSync(home, "tests/harness/git-snapshot-host.spec.ts");
  }
}, 120_000);
