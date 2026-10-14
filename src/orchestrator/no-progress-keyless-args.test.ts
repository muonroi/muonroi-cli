/**
 * The arg guard's OTHER refused class — `missing-required-args` — and the one
 * variance source that made even an IDENTICAL refused call look novel.
 *
 * ## What was measured, and what it does NOT show
 *
 * `f6738bb5` bounded the `elision-marker-as-args` class and left this note: the
 * sibling class "is not covered, and its refusal text carries the same strike
 * counter … Whether a keyless loop actually recurs is unmeasured here." It is
 * measured now, over the whole retained window of `~/.muonroi-cli/muonroi.db`
 * (23,434 rows, 6,165 of them `tool_result`, 2026-09-11T07:42:59Z ..
 * 2026-09-25T07:08:18Z), read-only:
 *
 *   SELECT session_id, COUNT(*) FROM interaction_logs
 *   WHERE event_type='tool_result' AND metadata_json LIKE '%without usable arguments%'
 *   GROUP BY session_id;
 *     f52d9bfc50a2  1   2026-09-18T17:07:50.379Z
 *     8b35c43e15dd  1   2026-09-15T03:30:45.170Z
 *     0f97f0afd5c8  1   2026-09-21T06:58:31.739Z
 *
 * THREE blocks in fourteen days. One per session, never two in a row, all on
 * `read_file`, and each repaired immediately — id 18777 (step 71) was followed at
 * step 72 by two successful `read_file` results; id 26897 (step 40) by a
 * successful `write_file` at step 41. The `LIKE '%without usable arguments%'`
 * form is used because bash's refusal carries the shared `empty-bash` token
 * (`arg-guard.ts`, `kindToken`) and a `%missing-required-args%` filter would miss
 * it; splitting all 92 bash BLOCKED rows by body found 58 elision-marker, 34
 * other kinds (`destructive-revert` and friends) and ZERO of this class.
 *
 * So this class does NOT loop. Against the same window the already-bounded class
 * ran 29 / 28 / 24 / 19 blocks in single sessions. No terminator is built here,
 * because there is no measured loop to terminate.
 *
 * ## The defect that IS real, independent of any loop
 *
 * `formatArgGuardMessage` interpolated the raw strike count into its top rung
 * ("N malformed tool calls in a row"). `createNoProgressGuard` keys every call on
 * `toolName + sha1(input) + sha1(resultText)` (`no-progress-guard.ts`), and this
 * class — unlike the marker class — contributes a key. For a call repeated
 * VERBATIM the tool name and `sha1(input)` are equal by construction, so the
 * guard's own escalation counter was the SOLE reason two byte-identical refused
 * calls hashed differently, and it grew without limit. That made the structural
 * rule unreachable for this class by construction, whether or not a run ever hit
 * it.
 *
 * Bounding the top rung's text is what these tests pin: strikes 1 and 2 are
 * already bounded (each rung fires at exactly one count), so only the `>= 3` rung
 * needed to stop carrying digits. Its wording stays TRUE at every strike — it
 * says "at least 3", it does not clamp the count to a false "3".
 *
 * Consequence, pinned below rather than engineered: once the text stabilises the
 * EXISTING rule reaches this class, and a verbatim-repeated keyless call ends the
 * loop at strike 9 (three distinct keys while the ladder climbs, then
 * `DEFAULT_NO_PROGRESS_STEPS` repeats) instead of never.
 *
 * Deliberately NOT claimed: this bounds a loop that re-emits the SAME malformed
 * call. A model inventing a fresh argument string every time still produces a
 * fresh `sha1(input)` and is not bounded by this. That was the escape route the
 * adjacent finding below took, and it is now closed for the population that
 * finding is about — not by keying text differently, which cannot work, but by
 * moving those calls into the class that contributes no key at all.
 *
 * ## The three live blocks have MOVED OUT of this class — read this before
 * ## believing the counts above are still this class's population
 *
 * All three carried a `__elided_note` key holding a FABRICATED sentence, from the
 * `tool_call` rows that produced them:
 *
 *   18776  read_file  {"__elided_note":"[earlier tool result elided — skip and re-read instead]"}
 *   23864  read_file  {"__elided_note":"[elided by compactor — see match for call #122]"}
 *   26896  read_file  {"__elided_note":"[earlier tool_call_result elided by compaction]"}
 *
 * They reached `missing-required-args` only because `carriesElidedArgsMarker` then
 * tested the marker's TEXT (`ELIDED_ARGS_PREFIX`, `startsWith`) while the model
 * imitates its SHAPE. That predicate now keys on the `__elided_note` KEY, so all
 * three are `elision-marker-as-args` — the already-bounded class — and are pinned
 * there, with the query that measured them, in
 * `src/orchestrator/no-progress-paraphrased-marker.test.ts`.
 *
 * Consequently the measurement quoted above ("three blocks in fourteen days")
 * describes the class as it was BEFORE that widening. Post-widening this class's
 * live population over the same window is ZERO, which is a stronger version of
 * the same conclusion — still no measured loop, so still no terminator — and the
 * fixtures below are therefore constructed keyless calls that carry no note at
 * all (`{}`, a line range with no path, an empty `file_paths`). They are what
 * genuinely lands in this branch now; using the three live strings here would
 * silently test the OTHER class.
 *
 * These tests drive the REAL pipeline (`buildTurnToolPipeline` over
 * `createBuiltinTools`) and feed its real bytes into the REAL
 * `createNoProgressGuard`, for the reason the sibling file gives: a hand-written
 * fixture for either half proves nothing about their composition.
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

/**
 * `read_file` inputs that supply neither `file_path` nor `file_paths` and carry
 * NO compaction note, which is what reaches the `missing-required-args` verdict
 * now that `carriesElidedArgsMarker` keys on the `__elided_note` key. Every key
 * used here is one `read_file` really declares (`start_line` / `end_line` /
 * `file_paths`), so each call is well-formed JSON against the schema and still
 * unrunnable — the shape this branch exists for.
 */
const KEYLESS_INPUTS: ReadonlyArray<Record<string, unknown>> = [
  {},
  { start_line: 1, end_line: 40 },
  { file_paths: [] },
];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "keyless-noprogress-"));
  dirs.push(d);
  for (let i = 0; i < 60; i++) {
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

describe("the arg guard's missing-required-args refusal text", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("refuses every one of the three keyless inputs and runs none of them", async () => {
    const call = livePipeline(tempDir(), "keyless-refusal");
    for (const [i, input] of KEYLESS_INPUTS.entries()) {
      const step = await call("read_file", input);
      const text = outputText(step);
      // The non-negotiable: blocking is what bounds the damage. Terminating is a
      // separate concern and must never be bought by permitting the call.
      expect(text, `live input ${i}`).toContain("BLOCKED (");
      expect(text, `live input ${i}`).toContain("was called without usable arguments");
      // Nothing was read: no file content can appear in a refusal.
      expect(text, `live input ${i}`).not.toContain("export const v");
    }
  }, 60_000);

  it("stops carrying the unbounded strike count once the ladder is at its top rung", async () => {
    const call = livePipeline(tempDir(), "keyless-text");
    // One keyless input, re-emitted — the shape a stuck model produces. Collect
    // the refusal for each strike.
    const input = KEYLESS_INPUTS[0];
    const texts: string[] = [];
    for (let strike = 1; strike <= 8; strike++) {
      const step = await call("read_file", input);
      expect(outputText(step), `strike ${strike}`).toContain("BLOCKED (");
      texts.push(outputText(step));
    }

    // Rungs 1 and 2 are already bounded — each fires at exactly one count — and
    // must keep escalating, so they stay distinct.
    expect(texts[0]).not.toMatch(/malformed tool calls in a row/);
    expect(texts[1]).toMatch(/2 malformed tool calls in a row/);
    expect(texts[2]).toMatch(/3 malformed tool calls in a row/);
    expect(texts[2]).toMatch(/STOP issuing tool calls/);

    // The top rung must not grow a new sentence per strike. Strikes 3..8 all sit
    // on it, so they must be byte-identical. This is the assertion that was red:
    // the raw count was interpolated, so all six differed.
    const topRung = new Set(texts.slice(2));
    expect(topRung.size, `distinct top-rung texts across strikes 3..8: ${[...topRung].length}`).toBe(1);

    // Bounded, and still TRUE at strike 8 — the count is not clamped to a false
    // "3 in a row", it is stated as a floor.
    expect(texts[7]).toContain("at least 3 malformed tool calls in a row");
  }, 60_000);
});

describe("no-progress guard vs. a verbatim-repeated keyless call", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("ends a loop that re-emits the identical refused call, within a bounded number of steps", async () => {
    const call = livePipeline(tempDir(), "keyless-bound");
    // Passed explicitly so the bound this test pins cannot be moved by
    // MUONROI_NO_PROGRESS_STEPS in the ambient environment.
    const limit = DEFAULT_NO_PROGRESS_STEPS;
    const guard = createNoProgressGuard(limit);
    const input = KEYLESS_INPUTS[0];
    const steps: Step[] = [];
    let stoppedAfter: number | null = null;

    for (let i = 0; i < limit * 6 && stoppedAfter === null; i++) {
      const step = await call("read_file", input);
      // Terminating is the fix; permitting is not.
      expect(outputText(step), `step ${i + 1}`).toContain("BLOCKED (");
      steps.push(step);
      if (guard(steps)) stoppedAfter = steps.length;
    }

    // Before the text was bounded this ran to exhaustion with the guard still
    // false — the escalation ladder just kept counting. Now: three distinct keys
    // while the ladder climbs (strikes 1, 2, 3), then `limit` repeats of the
    // stable top rung.
    expect(stoppedAfter).not.toBeNull();
    expect(stoppedAfter).toBe(3 + limit);
    expect(limit).toBe(6);
  }, 60_000);

  it("a step that also makes a genuinely new well-formed call is still progress", async () => {
    const call = livePipeline(tempDir(), "keyless-mixed");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // The property `f6738bb5` pins for the sibling class, held here too: a run
    // getting somewhere alongside a malformed call must not be killed.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      const blocked = await call("read_file", KEYLESS_INPUTS[0]);
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

  it("a refused keyless call repaired on the very next call never trips the guard", async () => {
    const call = livePipeline(tempDir(), "keyless-recover");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // This is the MEASURED pattern for the blocks this class was diagnosed from:
    // every one was a singleton followed by real work (they are now the marker
    // class — see the header). It must stay alive however long it runs.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      steps.push(await call("read_file", KEYLESS_INPUTS[i % KEYLESS_INPUTS.length]));
      expect(guard(steps), `after block ${i + 1}`).toBe(false);
      steps.push(await call("read_file", { file_path: `f${i}.ts` }));
      expect(guard(steps), `after recovery ${i + 1}`).toBe(false);
    }
  }, 60_000);
});
