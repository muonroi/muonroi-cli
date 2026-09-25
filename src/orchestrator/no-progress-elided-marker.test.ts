/**
 * The elision marker must not make a refused call look like progress.
 *
 * Measured live (`/ideal` run muc2joffe506, session bf39c59e4dd1,
 * `~/.muonroi-cli/muonroi.db`): 29 BLOCKED tool results in ~10 minutes, a
 * sub-agent climbing through stepIndex 207-211. Verbatim `tool_call`
 * `argsPreview` rows:
 *
 *   04:15:17  git_commit  {"__elided_note":"[earlier call args elided by sub-agent compactor — 429 chars; …]"}
 *   04:15:24  git_commit  {"__elided_note":"[earlier call args elided by sub-agent compactor — 1250 chars; …]"}
 *   04:15:42  bash        {"__elided_note":"[earlier call args elided by sub-agent compactor — 280 chars; …]"}
 *
 * `src/tools/arg-guard.ts` refused every one of them, correctly. Refusing did
 * not END anything, and the same loop is already documented from an earlier
 * session in `tool-pipeline-arg-guard.test.ts` — so a louder guard message is
 * not the fix. What was supposed to end it is the loop's termination predicate.
 *
 * The sub-agent loop that spun has NO step cap (`/ideal` removes it) — its only
 * terminator is `createNoProgressStopWhen()` (`stream-runner.ts:650`). That
 * guard keys each call on `toolName + sha1(input) + sha1(resultText)`
 * (the key built inside `createNoProgressGuard`), and all three varied on each of
 * these calls:
 *
 *   1. the marker embeds `${sz}`, the byte count of the args it replaced
 *      (`subagent-compactor.ts:928`) — 429, 1250, 280, so `sha1(input)` differs;
 *   2. the tool name alternates (`git_commit`, `git_commit`, `bash`);
 *   3. the guard's own escalation counter is inside its output text
 *      (`arg-guard.ts:226`, `:232`) — "N malformed tool calls in a row" — so
 *      `sha1(resultText)` differs on every strike, forever.
 *
 * Every step therefore registered a brand-new key, `allRepeats` was false, and
 * the streak reset to 0 each time. The diagnostics of the compactor and of the
 * guard are what made the repetition invisible to the only thing watching for it.
 *
 * These tests drive the REAL pipeline (`buildTurnToolPipeline` over
 * `createBuiltinTools`) so the outputs fed to the guard are the bytes the guard
 * actually emits, then feed those triples into the REAL
 * `createNoProgressGuard`. A hand-written fixture for either half would prove
 * nothing about their composition.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "../tools/registry.js";
import { createNoProgressGuard, DEFAULT_NO_PROGRESS_STEPS } from "./no-progress-guard.js";
import { buildTurnToolPipeline } from "./tool-engine.js";
import { _resetForTests, recordToolError, _internals as repetitionInternals } from "./tool-repetition-detector.js";

/**
 * The three arg objects the run actually emitted, char counts included. The
 * differing counts ARE the defect — a fixture that reuses one string cannot
 * expose it.
 */
const LIVE_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  [
    "git_commit",
    {
      __elided_note:
        "[earlier call args elided by sub-agent compactor — 429 chars; consult the matching tool_result for what came back]",
    },
  ],
  [
    "git_commit",
    {
      __elided_note:
        "[earlier call args elided by sub-agent compactor — 1250 chars; consult the matching tool_result for what came back]",
    },
  ],
  [
    "bash",
    {
      __elided_note:
        "[earlier call args elided by sub-agent compactor — 280 chars; consult the matching tool_result for what came back]",
    },
  ],
];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "elide-noprogress-"));
  dirs.push(d);
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(d, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
  }
  return d;
}

interface Step {
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
}

/** A live tool-set, wrapped exactly as `executeToolEngine` wraps it. */
function livePipeline(cwd: string, sessionId: string) {
  const raw = createBuiltinTools(new BashTool(cwd), "agent", { sessionId }) as unknown as ToolSet;
  const built = buildTurnToolPipeline(raw, {
    capOptions: {
      maxCumulativeChars: 400_000,
      midTierRatio: 0.5,
      highTierRatio: 0.8,
      label: "top-level",
      dedupRepeatOutputs: true,
    },
    dedup: null,
    readBudget: null,
  });
  let seq = 0;
  return async (toolName: string, input: unknown): Promise<Step> => {
    const tool = built.tools[toolName] as { execute?: (i: unknown, ctx?: unknown) => unknown };
    if (!tool?.execute) throw new Error(`tool ${toolName} missing from the pipeline`);
    const output = await tool.execute(input, {});
    const toolCallId = `live-${seq++}`;
    return {
      toolCalls: [{ toolCallId, toolName, input }],
      toolResults: [{ toolCallId, toolName, output }],
    };
  };
}

function outputText(step: Step): string {
  const out = step.toolResults[0]?.output;
  return typeof out === "string" ? out : JSON.stringify(out);
}

describe("no-progress guard vs. the elision marker the compactor writes", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
    _resetForTests();
  });

  it("stops a sub-agent that only re-emits the marker, within the step limit", async () => {
    const call = livePipeline(tempDir(), "elide-bound");
    // The limit is passed explicitly so the bound this test pins cannot be moved
    // by MUONROI_NO_PROGRESS_STEPS in the ambient environment.
    const limit = DEFAULT_NO_PROGRESS_STEPS;
    const guard = createNoProgressGuard(limit);
    const steps: Step[] = [];
    let stoppedAfter: number | null = null;

    // Four times the limit of steps, cycling the live sequence — differing char
    // counts, interleaved tool names, exactly as measured.
    for (let i = 0; i < limit * 4 && stoppedAfter === null; i++) {
      const [toolName, input] = LIVE_CALLS[i % LIVE_CALLS.length];
      const step = await call(toolName, input);
      // The guard must still REFUSE the call. Terminating is the fix; permitting
      // is not.
      expect(outputText(step), `step ${i + 1}`).toContain("BLOCKED (");
      steps.push(step);
      if (guard(steps)) stoppedAfter = steps.length;
    }

    // Measured before the fix: 24 consecutive blocks with the guard still false
    // (escalation ladder at strike 24), i.e. no bound at all — matching the 29
    // of the live run.
    expect(stoppedAfter).not.toBeNull();
    expect(stoppedAfter).toBe(limit);
    expect(limit).toBe(6);
  }, 60_000);

  it("a step that also makes a genuinely new well-formed call is still progress", async () => {
    const call = livePipeline(tempDir(), "elide-mixed");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // Each step: one refused marker call AND one real read of a file never read
    // before. A run that is getting somewhere alongside a malformed call must
    // not be killed.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      const [toolName, input] = LIVE_CALLS[i % LIVE_CALLS.length];
      const blocked = await call(toolName, input);
      const real = await call("read_file", { file_path: `f${i}.ts` });
      expect(outputText(blocked)).toContain("BLOCKED (");
      expect(outputText(real)).toContain(`export const v${i}`);
      steps.push({
        toolCalls: [...blocked.toolCalls, ...real.toolCalls],
        toolResults: [...blocked.toolResults, ...real.toolResults],
      });
      expect(guard(steps), `after ${steps.length} mixed steps`).toBe(false);
    }
  }, 60_000);

  it("a marker call followed by a real recovery every time never trips the guard", async () => {
    const call = livePipeline(tempDir(), "elide-recover");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // The measured recovery pattern: 2 of the 3 blocks in the 2026-09-09 run
    // were repaired on the very next call. Blocks interleaved with real progress
    // must stay alive however long they go on.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      const [toolName, input] = LIVE_CALLS[i % LIVE_CALLS.length];
      steps.push(await call(toolName, input));
      expect(guard(steps), `after block ${i + 1}`).toBe(false);
      steps.push(await call("read_file", { file_path: `f${i}.ts` }));
      expect(guard(steps), `after recovery ${i + 1}`).toBe(false);
    }
  }, 60_000);
});

describe("why the tool-repetition detector is not the place this loop can be caught", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("the char count in the marker gives every call a different args hash", () => {
    const hashes = new Set(LIVE_CALLS.map(([, input]) => repetitionInternals.hashInput(input)));
    // Three semantically identical, identically un-runnable calls; three hashes.
    expect(hashes.size).toBe(LIVE_CALLS.length);
  });

  it("the live sequence never reaches the detector's consecutive-run trigger", () => {
    const err = 'BLOCKED (elision-marker-as-args): "__elided_note" is a history-compaction marker';
    const runs: number[] = [];
    for (let i = 0; i < repetitionInternals.TRIGGER_RUN_LENGTH * 4; i++) {
      const [toolName, input] = LIVE_CALLS[i % LIVE_CALLS.length];
      const r = recordToolError("elide-detector", toolName, input, err);
      expect(r.shouldAbort).toBe(false);
      runs.push(r.runLength);
    }
    // Differing char counts AND alternating tool names: the run length never
    // leaves 1, so the trigger is unreachable on this sequence.
    expect(new Set(runs)).toEqual(new Set([1]));
  });
});
