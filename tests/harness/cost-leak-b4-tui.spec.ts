/**
 * tests/harness/cost-leak-b4-tui.spec.ts
 *
 * Phase D B4 — TUI E2E: top-level `prepareStep` compactor rewrites older
 * tool_result parts into short summary stubs once cumulative message-chars
 * exceed MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS.
 *
 * Strategy (fall-back per Phase D constraints): rather than synthesize a
 * full `task` tool round-trip through the production sub-agent registry,
 * we lower the top-level threshold to 10_000 and drive the production
 * top-level loop with multi-round `read_file` tool-calls against a single
 * 30k-char fixture file. The orchestrator's top-level streamText prepareStep
 * (src/orchestrator/orchestrator.ts ~line 4110) is the same code path that
 * fires under real workloads, so this exercises the production wiring end
 * to end — only the trigger is synthetic.
 *
 * Verification: after the run, the dumped doStreamCalls show messages
 * containing the literal "[elided by top-level compactor]" marker on at
 * least one call after round 2.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { loadDumpedRecordings } from "./recording.js";

const LARGE_PAYLOAD_CHARS = 30_000;

function buildToolCallRound(callId: string, filePath: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: callId,
      toolName: "read_file",
      input: JSON.stringify({ file_path: filePath }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

function buildFinalTextRound(): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "final" },
    { type: "text-delta", id: "final", delta: "done" },
    { type: "text-end", id: "final" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

describe("B4 TUI: top-level compactor reduces cumulative prompt size", () => {
  let handle: CostLeakHarness | null = null;
  let payloadDir: string;

  beforeAll(async () => {
    // Pre-build large files the mock will reference. Use distinct files (and
    // distinct content) so the cross-turn dedup wrapper does not collapse
    // identical outputs into "[duplicate tool output detected]" — that
    // collapses content BEFORE compaction can see it, masking the invariant
    // we want to verify.
    payloadDir = mkdtempSync(join(tmpdir(), "muonroi-cl-b4-payload-"));
    for (let i = 1; i <= 4; i++) {
      const p = join(payloadDir, `big${i}.txt`);
      // Each file gets unique content so dedup hashes differ across rounds.
      const marker = `payload-${i}-${"ABCDEFGH".repeat(4)}\n`;
      writeFileSync(p, marker + "x".repeat(LARGE_PAYLOAD_CHARS - marker.length), "utf8");
    }

    // Force compactor to trigger on small fixtures by lowering the threshold
    // well below LARGE_PAYLOAD_CHARS. spawnCostLeakHarness inherits process.env
    // via helpers.ts, so this propagates to the child.
    // The settings.ts validator clamps the threshold to [50_000, 1_500_000];
    // anything outside that range silently falls back to the 200_000 default.
    // Use 50_000 (the minimum) so compaction kicks in as early as possible
    // given our ~30k per-round payload.
    process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "50000";
    process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST = "1";

    handle = await spawnCostLeakHarness({
      provider: "siliconflow",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      stream: [
        buildToolCallRound("c1", join(payloadDir, "big1.txt")),
        buildToolCallRound("c2", join(payloadDir, "big2.txt")),
        buildToolCallRound("c3", join(payloadDir, "big3.txt")),
        buildToolCallRound("c4", join(payloadDir, "big4.txt")),
        buildFinalTextRound(),
      ],
    });
  }, 30_000);

  afterAll(() => {
    handle?.cleanup();
    try {
      rmSync(payloadDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("dumped calls contain the top-level compactor elision marker on a later round", async () => {
    if (!handle) throw new Error("harness failed to spawn");

    // Drive the multi-round loop with a single prompt — the model emits
    // tool-calls in rounds 1..4 then final text in round 5.
    handle.driver.type("please read the project source files and summarize the architecture for me");
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 30_000 });
    // Give the multi-round loop time to complete all 5 rounds. Each round
    // executes read_file → 30k content appended → next streamText call.
    // The orchestrator runs the full multi-round loop synchronously inside
    // streamText; 20s is enough for 5 rounds + tool executions.
    await new Promise((r) => setTimeout(r, 35000));

    await exitTuiAndWaitForDump(handle, 30_000);

    expect(existsSync(handle.dumpPath)).toBe(true);
    const calls = loadDumpedRecordings(handle.dumpPath);
    // Expect at least 3 rounds to have happened (compaction needs prior tool
    // turns to elide). The exact count depends on maxToolRounds + finish
    // reasons — we just need enough rounds for compaction to fire.
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Find any call whose serialized prompt contains the top-level marker.
    const elidedCalls = calls.filter((c) => {
      try {
        const promptText = JSON.stringify(c.options.prompt);
        return promptText.includes("elided by top-level compactor");
      } catch {
        return false;
      }
    });
    if (elidedCalls.length === 0) {
      // Helpful diagnostic if the assertion is about to fail.
      const lastPrompt = JSON.stringify(calls[calls.length - 1]?.options.prompt ?? "").slice(0, 500);
      throw new Error(
        `No top-level compaction marker found across ${calls.length} calls. ` +
          `Last-call prompt prefix: ${lastPrompt}`,
      );
    }
    expect(elidedCalls.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
