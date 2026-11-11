/**
 * tests/harness/compaction-reasoning-collapse.spec.ts
 *
 * A reasoning summarizer that spends its whole output budget thinking must not
 * collapse compaction, and a compaction no summarizer can produce must still
 * leave the session usable — never a silent dead turn.
 *
 * Evidence (TCIS replay, session c2fda568be6b, 2026-11-06): from 07:11:56Z
 * every summary came back `finishReason=length outputTokens=1536 budget=1536
 * textChars=0 reasoningChars≈6.5k` on step-3.7-flash and step-5-preview; 41
 * compactions logged "saved 0"; from 11:25Z 15 consecutive turns made no model
 * call and left no assistant message.
 *
 * Shape (StepFun; the orchestrator routes to the provider flagship, a 1M
 * window, so the kept tail is 100k est tokens and each turn reads ~130k):
 *   turn 1 — eight 30k reads, final text. The post-turn compaction's summarizer
 *            answers reasoning-only + finishReason=length, then (retry) a real
 *            summary carrying SUMMARY_SENTINEL.
 *   turn 2 — eight more reads, final text. Every summarizer call now answers
 *            reasoning-only + length (initial, retry, main-model fallback):
 *            the no-LLM path runs.
 *   turn 3 — plain text answer.
 * Asserted: the summary budget is the catalog's reasoning budget (not the
 * inlined 1536/4096), the retry asks for MORE, the retried summary reaches the
 * next turn's prompt, and after the all-fail compaction turn 3 still makes its
 * model call and shows its answer.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { type InspectedCall, isMainAgentCall, loadDumpedRecordings } from "./recording.js";

const SUMMARIZER_SIGNATURE = "You are a context summarization assistant";
const SUMMARY_SENTINEL = "RETRIED_SUMMARY_SENTINEL_5c1e";
const TURN1 = "read the first eight data files and describe them";
const TURN2 = "now read the next eight data files";
const READS_PER_TURN = 8;
const TURN3 = "what is the status now";

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function toolRound(callId: string, filePath: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
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

/** What step-3.7-flash did in c2fda568be6b: all reasoning, no text, cut at the cap. */
function reasoningOnlyLength(): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Let me think about how to summarize this. ".repeat(150) },
    { type: "reasoning-end", id: "r" },
    { type: "finish", finishReason: { unified: "length", raw: undefined }, usage: usage(9_000, 8_192) },
  ];
}

/** Token-dense, distinct file content (hex) so each read is ~10k BPE tokens and never dedups. */
function hexFile(seed: number, chars: number): string {
  let x = seed * 2654435761;
  let out = `file-${seed}-marker\n`;
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += x.toString(16).padStart(8, "0");
    if (out.length % 96 < 8) out += "\n";
  }
  return out.slice(0, chars);
}

const summarizerCalls = (calls: InspectedCall[]) => calls.filter((c) => c.systemText.includes(SUMMARIZER_SIGNATURE));

function load(handle: CostLeakHarness): InspectedCall[] {
  if (!existsSync(handle.dumpPath)) return [];
  try {
    return loadDumpedRecordings(handle.dumpPath);
  } catch (err) {
    // Dump mid-rotation — the atomic rename means the next read is clean.
    console.debug(`[collapse spec] dump not readable yet: ${(err as Error).message}`);
    return [];
  }
}

async function waitFor(handle: CostLeakHarness, pred: (calls: InspectedCall[]) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(load(handle))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const calls = load(handle);
  throw new Error(
    `[collapse spec] timed out: ${calls.length} calls, ${calls.filter(isMainAgentCall).length} main, ` +
      `${summarizerCalls(calls).length} summarizer; post-turn-compact decisions: ${postTurnDecisions()}; ` +
      `call system heads: ${JSON.stringify(calls.map((c) => c.systemText.slice(0, 60)))}; ` +
      `child compaction log: ${childCompactionLog(handle)}`,
  );
}

/** Post-turn compaction is fire-and-forget: wait until no new model call has been recorded for 4s. */
async function waitStable(handle: CostLeakHarness): Promise<void> {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const n = load(handle).length;
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 4_000) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The child's MUONROI_CLI_HOME, pinned so its decision log is readable for diagnostics. */
const cliHome = mkdtempSync(join(tmpdir(), "muonroi-collapse-home-"));

/** Compaction lines from the child's debug.log (its logger writes under MUONROI_CLI_HOME). */
function childCompactionLog(handle: CostLeakHarness): string {
  const file = [join(cliHome, "debug.log"), join(handle.workDir, "project", ".muonroi-cli", "debug.log")].find((f) =>
    existsSync(f),
  );
  try {
    if (!file) return "(no debug.log)";
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /compact|summar/i.test(l))
      .slice(-12)
      .map((l) => l.slice(0, 300))
      .join(" || ");
  } catch (err) {
    return `(unreadable: ${(err as Error).message})`;
  }
}

/** The child's own record of why post-turn compaction did or did not run. */
function postTurnDecisions(): string {
  const dir = join(cliHome, "usage");
  try {
    if (!existsSync(dir)) return "(no usage dir)";
    return readdirSync(dir)
      .filter((f) => f.startsWith("decision-log"))
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
      .filter((l) => l.includes("post-turn-compact"))
      .map((l) => {
        const d = JSON.parse(l) as { taken?: boolean; reason?: string };
        return `${d.taken}:${d.reason}`;
      })
      .join(" | ");
  } catch (err) {
    return `(unreadable: ${(err as Error).message})`;
  }
}

describe("compaction survives a reasoning summarizer that returns no text", () => {
  let handle: CostLeakHarness | null = null;

  beforeAll(async () => {
    const projectFiles: Record<string, string> = {};
    for (let i = 1; i <= 2 * READS_PER_TURN; i++) projectFiles[`data${i}.txt`] = hexFile(i, 30_000);
    const reads = (prefix: string, first: number) =>
      Array.from({ length: READS_PER_TURN }, (_, k) => toolRound(`${prefix}${k}`, `data${first + k}.txt`));
    handle = await spawnCostLeakHarness(
      {
        provider: "stepfun",
        modelId: "step-3.7-flash",
        stream: [
          ...reads("a", 1),
          textRound("t1", "TURN1_DONE"),
          ...reads("b", READS_PER_TURN + 1),
          textRound("t2", "TURN2_DONE"),
          textRound("t3", "TURN3_DONE"),
        ],
        routes: [
          {
            systemIncludes: SUMMARIZER_SIGNATURE,
            // compaction 1: empty+length, then the wider retry succeeds;
            // compaction 2 onward: the last entry repeats — every call empty.
            stream: [
              reasoningOnlyLength(),
              textRound("s1", `## Goal\nDescribe the data files. ${SUMMARY_SENTINEL}\n## Progress\nRead data1-4.`),
              reasoningOnlyLength(),
            ],
          },
        ],
      },
      {
        modelId: "step-3.7-flash",
        permission: "auto-edit",
        projectFiles,
        // Post-turn compaction at 2k tokens so the scripted history triggers it.
        // In-turn B4 stubbing off, so each turn's history really is ~130k est tokens.
        env: {
          MUONROI_AUTO_COMPACT_ABS_FLOOR: "2000",
          MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS: "1500000",
          MUONROI_CLI_HOME: cliHome,
        },
      },
    );
  }, 120_000);

  afterAll(() => {
    handle?.cleanup();
    rmSync(cliHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("retries a reasoning-only summary wider, and a turn after an all-fail compaction still answers", async () => {
    if (!handle) throw new Error("harness failed to spawn");
    const h = handle;

    h.driver.type(TURN1);
    h.driver.press("Enter");
    // Turn 1's main calls, then the post-turn compaction's initial + retry summary.
    await waitFor(h, (c) => summarizerCalls(c).length >= 2, 120_000);
    await waitStable(h);

    h.driver.type(TURN2);
    h.driver.press("Enter");
    await waitFor(
      h,
      (c) => c.filter((x) => isMainAgentCall(x) && x.userText.includes(TURN2)).length >= READS_PER_TURN + 1,
      120_000,
    );
    // Compaction 2: every summarizer call is reasoning-only (incl. retries and the main-model fallback).
    await waitFor(h, (c) => summarizerCalls(c).length >= 4, 120_000);
    await waitStable(h);

    h.driver.type(TURN3);
    h.driver.press("Enter");
    await waitFor(h, (c) => c.some((x) => isMainAgentCall(x) && x.userText.includes(TURN3)), 60_000);
    await h.driver.wait_for({ idle: true, timeoutMs: 30_000 });
    const screen = h.driver.render_text();
    await exitTuiAndWaitForDump(h, 30_000);

    const calls = loadDumpedRecordings(h.dumpPath);
    const summ = summarizerCalls(calls);
    const trace = summ.map((c) => ({ index: c.index, maxOutputTokens: c.options.maxOutputTokens }));
    console.info(`[collapse spec] summarizer calls: ${JSON.stringify(trace)}`);

    // (1) The summary budget is the catalog's reasoning budget, not the inlined
    // visible cap that reasoning ate in c2fda568be6b (1536).
    expect(summ[0]!.options.maxOutputTokens).toBeGreaterThan(4_096);
    // (2) The empty+length result was retried ONCE with MORE room.
    expect(summ[1]!.options.maxOutputTokens).toBeGreaterThan(summ[0]!.options.maxOutputTokens!);
    // (3) The retried summary is what the next turn carries.
    const turn2Main = calls.filter((c) => isMainAgentCall(c) && c.userText.includes(TURN2));
    expect(JSON.stringify(turn2Main[0]!.options.prompt)).toContain(SUMMARY_SENTINEL);
    // (4) After a compaction no summarizer could produce, the next turn still
    // makes its model call (never a silent, call-less turn) and its answer shows.
    const turn3Main = calls.filter((c) => isMainAgentCall(c) && c.userText.includes(TURN3));
    expect(turn3Main.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(turn3Main[0]!.options.prompt)).toContain("Mechanical compaction");
    expect(screen).toContain("TURN3_DONE");
  }, 360_000);
});
