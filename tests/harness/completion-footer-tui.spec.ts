/**
 * tests/harness/completion-footer-tui.spec.ts
 *
 * TUI E2E: the orchestrator pins a root goal with open items (context_load
 * working_set), then its final text says "Everything is done." The host checks
 * the final text against its own ledger (completion-check.ts, tool-engine
 * finalize) and appends a visible "Host completion check" footer listing the
 * open items — the model's text itself is not rewritten.
 *
 * Before: the root_status gate only fired when the model itself asked to mark
 * the root complete; a free-text "done" (session 4edc02516a92 seq 680) passed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function toolCallRound(callId: string, toolName: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function textRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

describe("completion footer TUI: a 'done' answer with open root-goal items gets a host footer", () => {
  let handle: CostLeakHarness | null = null;

  beforeAll(async () => {
    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        stream: [
          toolCallRound("ctx-1", "context_load", {
            topic: "working_set",
            action: "update",
            expected_revision: 0,
            task_id: "parser",
            goal: "Ship the parser",
            open_items: ["wire the CLI flag", "README section"],
          }),
          textRound("Everything is done."),
        ],
      },
      { isolatedCwd: true },
    );
  }, 120_000);

  afterAll(() => handle?.cleanup());

  it("renders the open items under the model's unchanged answer", async () => {
    if (!handle) throw new Error("harness failed to spawn");
    const h = handle;
    h.driver.type("ship the parser end to end");
    h.driver.press("Enter");

    // The semantic listitem name is truncated to 40 chars; assert on the real
    // rendered cell grid (VisualFrame) instead.
    await h.driver.wait_for({ visualText: "wire the CLI flag", timeoutMs: 90_000 }).catch((err: unknown) => {
      process.stderr.write(`[completion-footer-tui] TUI at timeout:\n${h.driver.render_visual()}\n`);
      throw err;
    });
    const screen = h.driver.render_visual();
    expect(screen).toContain("Everything is done.");
    expect(screen).toContain("Host completion check");
    expect(screen).toContain("open item(s)");
    expect(screen).toContain("README section");
    // Exactly one answer: the footer is appended once, not re-rendered per frame.
    expect(screen.split("Host completion check").length - 1).toBe(1);

    await exitTuiAndWaitForDump(h, 30_000);
  }, 150_000);
});
