/**
 * tests/harness/cache-turnstart-prefix.spec.ts
 *
 * A turn that STARTS with history already over the top-level compaction
 * threshold must compact BEFORE step 0, so every later step of the turn is an
 * append-only extension of the step before it (provider prompt caches are byte
 * prefixes).
 *
 * Evidence (session 4edc02516a92, prompt_breakdown + usage_events): in 77 of
 * 144 orchestrator turns step 0 sent the un-compacted history (avg 50 messages /
 * 293k chars, 61 of them with zero cache read) and step 1 of the SAME turn
 * dropped to avg 23 messages / 83k chars — a second rewrite of the prefix one
 * step later. The step-0 un-compaction was the C3 compaction consult's
 * `defer` branch (tool-engine.ts prepareStep): it hands step 0 back
 * un-compacted and compacts on step 1.
 *
 * Shape of the run:
 *   turn 1 — the mock emits `PRESERVE_FULL_CONTEXT` (context-preservation.ts)
 *            and reads three 30k files, so turn 1 never compacts and leaves no
 *            request-history replay — the same state a turn starts in after a
 *            summarizing compaction (the 4edc case).
 *   turn 2 — two small reads, then a final answer. Step 0 is over threshold.
 *
 * Asserted on turn 2's main-agent calls:
 *   - step 0 already carries the top-level elision marker (compacted first);
 *   - step 0 -> 1: every message of step 0 except its LAST one (the turn's user
 *     message — the per-step reminder channel, attachReminderToMessages + the
 *     system-message fold, lands there) is a byte-identical prefix of step 1;
 *   - every later step keeps the whole compacted carried-in history plus the
 *     turn's user message byte-identical.
 *
 * Documented remaining in-turn rewrite: coalesceReadOnlyMessages (tool-engine.ts)
 * merges consecutive read-only assistant/tool pairs AFTER the turn's user
 * message, so a new read-only step rewrites the turn's own tail (seen here as
 * 12 -> 12 messages with a 10-message common prefix). In 4edc02516a92 those
 * "same message count" transitions (194) billed 19.5k fresh tokens per call
 * against 19.4k for plain +2 appends (339) — no measurable cost under StepFun's
 * 16k-token cache blocks — so it is pinned here rather than changed.
 * The O3 hysteresis re-compaction (cumulative growth past 1.15x) is the other
 * designed boundary; the turn-2 reads are kept small so it does not fire.
 */

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { type InspectedCall, isMainAgentCall, loadDumpedRecordings } from "./recording.js";

const TURN1_PROMPT = "please read the project source files and summarize the architecture for me";
const TURN2_PROMPT = "now read the two notes files and list what they add";
const ELISION_MARKER = "elided by top-level compactor";

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function toolRound(callId: string, filePath: string, leadText?: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    ...(leadText
      ? [
          { type: "text-start", id: `t-${callId}` },
          { type: "text-delta", id: `t-${callId}`, delta: leadText },
          { type: "text-end", id: `t-${callId}` },
        ]
      : []),
    { type: "tool-call", toolCallId: callId, toolName: "read_file", input: JSON.stringify({ file_path: filePath }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(50, 20) },
  ];
}

function textRound(id: string, text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(60, 4) },
  ];
}

/** Number of leading prompt messages that are byte-identical in `a` and `b`. */
function commonPrefix(a: InspectedCall, b: InspectedCall): number {
  const pa = a.options.prompt;
  const pb = b.options.prompt;
  let i = 0;
  while (i < pa.length && i < pb.length && JSON.stringify(pa[i]) === JSON.stringify(pb[i])) i++;
  return i;
}

async function waitForMainCalls(handle: CostLeakHarness, n: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(handle.dumpPath)) {
      try {
        if (loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall).length >= n) return;
      } catch (err) {
        // Dump mid-rotation — the atomic rename means the next read is clean.
        console.debug(`[turnstart spec] dump not readable yet: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("turn-start compaction keeps the turn's prompt append-only", () => {
  let handle: CostLeakHarness | null = null;
  const saved = {
    threshold: process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS,
    keepLast: process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST,
  };

  beforeAll(async () => {
    // Distinct content per file so cross-turn dedup never collapses a result.
    const projectFiles: Record<string, string> = {};
    for (let i = 1; i <= 3; i++) {
      const marker = `big-${i}-${"QRSTUVWX".repeat(4)}\n`;
      projectFiles[`big${i}.txt`] = marker + "y".repeat(30_000 - marker.length);
    }
    // Turn 2 reads stay small: the O3 hysteresis (1.15x) must not re-compact
    // mid-turn, so any prefix break observed in turn 2 is the turn-start one.
    for (let i = 1; i <= 2; i++) {
      const marker = `note-${i}-${"KLMNOPQR".repeat(4)}\n`;
      projectFiles[`note${i}.txt`] = marker + "z".repeat(2_000 - marker.length);
    }
    // 50_000 is the settings.ts floor; keepLast=1 so turn 1's three tool turns
    // are elidable at the start of turn 2.
    process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "50000";
    process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST = "1";

    handle = await spawnCostLeakHarness(
      {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        stream: [
          // turn 1: preservation veto keeps the whole turn un-compacted.
          toolRound("r1", "big1.txt", "PRESERVE_FULL_CONTEXT\n"),
          toolRound("r2", "big2.txt"),
          toolRound("r3", "big3.txt"),
          textRound("t1", "architecture summarized"),
          // turn 2
          toolRound("n1", "note1.txt"),
          toolRound("n2", "note2.txt"),
          textRound("t2", "notes listed"),
        ],
      },
      { permission: "auto-edit", projectFiles },
    );
  }, 120_000);

  afterAll(() => {
    handle?.cleanup();
    if (saved.threshold === undefined) delete process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS;
    else process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = saved.threshold;
    if (saved.keepLast === undefined) delete process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST;
    else process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST = saved.keepLast;
  });

  it("compacts before step 0 and never rewrites an earlier step's prefix", async () => {
    if (!handle) throw new Error("harness failed to spawn");

    handle.driver.type(TURN1_PROMPT);
    handle.driver.press("Enter");
    await waitForMainCalls(handle, 4, 60_000);
    // Let turn 1 persist its final answer before the next prompt is typed.
    await new Promise((r) => setTimeout(r, 2_000));

    handle.driver.type(TURN2_PROMPT);
    handle.driver.press("Enter");
    await waitForMainCalls(handle, 7, 60_000);
    await exitTuiAndWaitForDump(handle, 30_000);

    const main = loadDumpedRecordings(handle.dumpPath).filter(isMainAgentCall);
    const turn2 = main.filter((c) => c.userText.includes(TURN2_PROMPT));
    if (turn2.length === 0)
      console.info(
        `[turnstart spec] no turn-2 call among ${main.length} main calls; last user text: ${JSON.stringify(main.at(-1)?.userText.slice(-400))}`,
      );
    const trace = turn2.map((c, i) => ({
      step: i,
      messages: c.options.prompt.length,
      chars: c.promptChars,
      compacted: JSON.stringify(c.options.prompt).includes(ELISION_MARKER),
      prefixWithNext: i + 1 < turn2.length ? commonPrefix(c, turn2[i + 1]!) : null,
    }));
    console.info(`[turnstart spec] turn-2 steps: ${JSON.stringify(trace)}`);

    expect(turn2.length).toBeGreaterThanOrEqual(3);
    // Compacted BEFORE step 0, not deferred to step 1.
    expect(trace[0]!.compacted).toBe(true);
    // Step 0 -> 1: only step 0's last message (the turn's user message, which
    // carries the step-0 notice) may differ — everything carried in from
    // earlier turns is byte-stable.
    const step0Len = turn2[0]!.options.prompt.length;
    expect(trace[0]!.prefixWithNext, `step 0 -> 1 rewrote history (${JSON.stringify(trace)})`).toBeGreaterThanOrEqual(
      step0Len - 1,
    );
    // Every later step keeps at least that carried-in prefix AND the turn's
    // user message. The turn's own read-only tool pairs after it are merged by
    // coalesceReadOnlyMessages (tool-engine.ts) — the one remaining in-turn
    // rewrite, confined to this turn's tail (see the header).
    for (let i = 1; i + 1 < turn2.length; i++) {
      expect(
        trace[i]!.prefixWithNext,
        `step ${i} -> ${i + 1} rewrote history (${JSON.stringify(trace)})`,
      ).toBeGreaterThanOrEqual(step0Len);
    }
  }, 200_000);
});
