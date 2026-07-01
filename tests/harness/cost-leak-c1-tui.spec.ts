/**
 * tests/harness/cost-leak-c1-tui.spec.ts
 *
 * Phase D C1 — TUI E2E: DeepSeek-shaped usage with
 * `providerMetadata.deepseek.promptCacheHitTokens` must be normalized into
 * `cacheReadTokens` by `getUsage()` and surfaced through the orchestrator's
 * recordUsage path.
 *
 * Verification path:
 *   1. Spawn TUI with a mock fixture whose stream's `finish` chunk carries
 *      `providerMetadata.deepseek.{promptCacheHitTokens, promptCacheMissTokens}`.
 *   2. Drive a user prompt through the composer.
 *   3. Listen for the `usage` sidechannel event the orchestrator emits next
 *      to recordUsage (added in Phase D — see src/orchestrator/orchestrator.ts).
 *   4. Assert the emitted event carries `cacheReadTokens > 0`.
 *
 * This is the C1 invariant end-to-end: a real provider response with
 * DeepSeek-style cache split flows through getUsage → recordUsage and the
 * cache_read field is populated (not zero, as it was pre-fix).
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness } from "./helpers.js";

function writeDeepSeekFixture(dir: string): void {
  const fixture = {
    model: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      stream: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello from DeepSeek mock." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1000, noCache: 300, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: 50, reasoning: undefined },
          },
          // DeepSeek-specific cache split — getUsage() reads this and normalizes
          // promptCacheHitTokens into cacheReadTokens (see Phase C1 fix in
          // src/orchestrator/tool-utils.ts getUsage()).
          providerMetadata: {
            deepseek: {
              promptCacheHitTokens: 700,
              promptCacheMissTokens: 300,
            },
          },
        },
      ],
    },
  };
  writeFileSync(join(dir, "deepseek.json"), JSON.stringify(fixture), "utf8");
}

describe("C1 TUI: DeepSeek cache field split (promptCacheHitTokens -> cacheReadTokens)", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-cl-c1-"));
    const fixDir = join(workDir, "fix");
    mkdirSync(fixDir);
    writeDeepSeekFixture(fixDir);

    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fixDir],
      env: {
        MUONROI_NO_SHELL_HOLD: "1",
      },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[child] ${chunk.toString("utf8")}`);
    });

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    // POSIX race: idle can fire on the empty seq=0 frame before React mounts.
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
  }, 120_000);

  afterAll(() => {
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    cleanup?.();
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("orchestrator emits usage event with cacheReadTokens normalized from DeepSeek providerMetadata", async () => {
    driver.type("hi");
    driver.press("Enter");

    // Wait for at least one usage event to flow through the sidechannel.
    // last_event polls eventBuffer for matching kind.
    await driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });

    // Poll the event buffer for a usage event (recordUsage is async-ish within
    // streamText's onFinish — give it a generous window).
    let usageEvent: LiveEvent | null = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      usageEvent = driver.last_event("usage");
      if (usageEvent && (usageEvent as { cacheReadTokens?: number }).cacheReadTokens !== undefined) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(usageEvent).not.toBeNull();
    expect(usageEvent?.t).toBe("event");
    const payload = usageEvent as unknown as {
      kind: string;
      cacheReadTokens?: number;
      inputTokens?: number;
      model?: string;
    };
    expect(payload.kind).toBe("usage");
    // The fix: cacheReadTokens must be 700, not undefined/0.
    expect(payload.cacheReadTokens).toBe(700);
    expect(payload.inputTokens).toBe(1000);
  }, 45_000);
});
