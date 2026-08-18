/**
 * mcp-needs-key.spec.ts
 *
 * E2E: an ENABLED MCP server that is missing its API key surfaces the inline
 * "fix it here" card (id=mcp-needs-key-card) instead of the old per-turn
 * "⚠️ unavailable" console nag.
 *
 * Setup: seed <HOME>/.muonroi-cli/user-settings.json with Tavily enabled and NO
 * key. spawnHarness sets HOME → the temp cwd, so the child loads that config.
 * getMcpKey reads only the env var, so an empty TAVILY_API_KEY keeps it keyless
 * regardless of the developer's machine. At boot, warmMcpClients partitions the
 * keyless server out of the connect set and publishes it on the needs-key bus;
 * the bus buffers until React mounts, then the card renders.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/mcp-needs-key.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

describe("MCP needs-key inline card E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muonroi-needs-key-home-"));
    mkdirSync(join(home, ".muonroi-cli"), { recursive: true });
    // Tavily enabled but keyless → the card's trigger condition.
    writeFileSync(
      join(home, ".muonroi-cli", "user-settings.json"),
      JSON.stringify({
        mcp: {
          servers: [
            {
              id: "tavily",
              label: "Tavily Web Search",
              enabled: true,
              transport: "stdio",
              command: "bun",
              args: ["x", "-y", "tavily-mcp"],
              env: { TAVILY_API_KEY: "" },
            },
          ],
        },
      }),
      "utf8",
    );

    const ctx = await spawnHarness({
      cwd: home,
      // Force keyless even if the dev machine exports a real key (getMcpKey
      // reads only this env var; empty < 16 chars → treated as absent).
      env: { TAVILY_API_KEY: "", MUONROI_NO_SHELL_HOLD: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    // Mount guard: wait for the composer so React is really up before asserting
    // the modal (the boot publish is buffered on the bus until then).
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("shows the inline fix card for the enabled-but-keyless Tavily server", async () => {
    await driver.wait_for({ selector: "id=mcp-needs-key-card", timeoutMs: 20_000 });
    const card = driver.query("id=mcp-needs-key-card");
    expect(card).not.toBeNull();
    // It is a modal so the composer cannot swallow its keys.
    expect(card?.isModal).toBe(true);
  });

  it("offers the paste-key action for the keyless server", async () => {
    // The action list is derived from the MissingKeyServer descriptor; the
    // paste-key action is always present.
    const actions = driver.queryAll("id*=mcp-needs-key-action");
    expect(actions.length).toBeGreaterThan(0);
  });
});
