/**
 * The model paraphrases the elision marker, and the paraphrase escaped the bound.
 *
 * ## What was measured
 *
 * `f6738bb5` bounded the marker class: a call carrying the compaction marker
 * contributes NO key to `createNoProgressGuard`, so N such steps in a row end the
 * loop at `DEFAULT_NO_PROGRESS_STEPS`. `carriesElidedArgsMarker` is the single
 * predicate both that guard and `src/tools/arg-guard.ts` ask, so the terminator
 * and the executor count the same population.
 *
 * That predicate keyed on the marker's TEXT (`ELIDED_ARGS_PREFIX` is
 * `"[earlier call args elided"`, tested with `startsWith`). The model reproduces
 * the marker's SHAPE — the `__elided_note` key — with its own sentence.
 *
 * Re-measured 2026-09-25 over the whole retained window of
 * `~/.muonroi-cli/muonroi.db` (24,665 rows, 2026-09-11T08:10:22.027Z ..
 * 2026-09-25T08:31:40.430Z), opened read-only with `bun:sqlite`:
 *
 *   SELECT id, created_at, session_id, metadata_json FROM interaction_logs
 *   WHERE event_type='tool_result' AND metadata_json LIKE '%without usable arguments%'
 *
 * returns exactly 3 rows, and the `tool_call` row immediately preceding each one
 * carries this `argsPreview`:
 *
 *   18776  2026-09-15T03:30:45.169Z  sess=8b35c43e15dd  read_file
 *     {"__elided_note":"[earlier tool result elided — skip and re-read instead]"}
 *   23864  2026-09-18T17:07:50.379Z  sess=f52d9bfc50a2  read_file
 *     {"__elided_note":"[elided by compactor — see match for call #122]"}
 *   26896  2026-09-21T06:58:31.739Z  sess=0f97f0afd5c8  read_file
 *     {"__elided_note":"[earlier tool_call_result elided by compaction]"}
 *
 * All three carry the KEY (`hasElidedNoteKey=true` for each); none matches the
 * PREFIX (`prefixMatch=false` for each). So all three fell through to the
 * `missing-required-args` branch — the class `f265ff23` measured as non-looping
 * and therefore deliberately left with no terminator. A paraphrased marker
 * escaped the bound that `f6738bb5` built for exactly this pathology.
 *
 * For contrast, the same window's verbatim-marker blocks per session
 * (`metadata_json LIKE '%elision-marker-as-args%'`): 29, 19, 16, 15, 14, 9, 6, 5,
 * 2, 1, 1. That filter is a FLOOR, not the population: bash's refusal carries the
 * shared `empty-bash` token instead of the kind (`arg-guard.ts`, `kindToken`), so
 * bash's marker blocks are not counted by it. The comparison holds either way —
 * the paraphrase is rare, one per session, but it is the same pathology wearing
 * an invented sentence, and rarity is not a bound.
 *
 * ## The population change this file pins
 *
 * `carriesElidedArgsMarker` now keys on the `__elided_note` KEY. That MOVES the
 * three calls above out of `missing-required-args` and into
 * `elision-marker-as-args`, in BOTH consumers at once:
 *
 *   - `arg-guard.ts` gives them the marker refusal ("…is a history-compaction
 *     marker … never copy argument text out of earlier tool calls") instead of
 *     the "without usable arguments" one. They are still BLOCKED; only the
 *     diagnosis changes, and the new one is the true one.
 *   - `no-progress-guard.ts` withholds their key, so a step made only of them
 *     cannot reset the streak and a run of them ends at
 *     `DEFAULT_NO_PROGRESS_STEPS` — even when every sentence is freshly invented,
 *     which is precisely what the prefix test could never bound.
 *
 * `src/orchestrator/no-progress-keyless-args.test.ts` owns the class the three
 * moved OUT of; its fixtures are now genuinely keyless calls that carry no note
 * at all, so it still covers `missing-required-args`.
 *
 * Two predicates, two questions — see `subagent-compactor.ts`:
 *   - `isCompactorElisionMarker` — prefix-exact: "did THIS compactor write this
 *     marker?" (round-trip / idempotency; the compactor's own byte stability).
 *   - `carriesElidedArgsMarker` — shape: "does this call carry a compaction note
 *     anywhere the executor will refuse it?" (the population both guards count).
 *
 * These tests drive the REAL pipeline (`buildTurnToolPipeline` over
 * `createBuiltinTools`) and feed its real bytes into the REAL
 * `createNoProgressGuard`: a hand-written fixture for either half proves nothing
 * about their composition.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "../tools/registry.js";
import { createNoProgressGuard, DEFAULT_NO_PROGRESS_STEPS } from "./no-progress-guard.js";
import { buildElidedArgsInput, carriesElidedArgsMarker, isCompactorElisionMarker } from "./subagent-compactor.js";
import { buildTurnToolPipeline } from "./tool-engine.js";

/**
 * The three `read_file` inputs the runs actually emitted, verbatim from
 * `interaction_logs` rows 18776 / 23864 / 26896. Every sentence is invented: not
 * one of them starts with `ELIDED_ARGS_PREFIX`. Invented fixtures could not
 * demonstrate that a real model output escapes the predicate, so these are the
 * headline cases everywhere below.
 */
const LIVE_PARAPHRASED_MARKERS: ReadonlyArray<Record<string, unknown>> = [
  { __elided_note: "[earlier tool result elided — skip and re-read instead]" },
  { __elided_note: "[elided by compactor — see match for call #122]" },
  { __elided_note: "[earlier tool_call_result elided by compaction]" },
];

/** A file whose CONTENT talks about elision. Its arguments are clean. */
const DECOY_FILE = "mentions-elision.ts";
const DECOY_CONTENT = "// [earlier call args elided by sub-agent compactor — see the note] is discussed here\n";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "paraphrased-marker-"));
  dirs.push(d);
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(d, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
  }
  writeFileSync(join(d, DECOY_FILE), DECOY_CONTENT, "utf8");
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

describe("carriesElidedArgsMarker keys on the __elided_note KEY, not its sentence", () => {
  it("matches all three live paraphrases", () => {
    for (const [i, input] of LIVE_PARAPHRASED_MARKERS.entries()) {
      expect(carriesElidedArgsMarker(input), `live paraphrase ${i}: ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it("still matches everything the prefix test matched", () => {
    // The compactor's own object form, and the legacy bare-string form still
    // present in histories persisted before the wire-validity fix.
    expect(carriesElidedArgsMarker(buildElidedArgsInput(4395))).toBe(true);
    expect(carriesElidedArgsMarker(buildElidedArgsInput(4395).__elided_note)).toBe(true);
    // The marker landed in an argument SLOT — the scan `f6738bb5` added, kept
    // verbatim so a marker shaped like real arguments still cannot reach the
    // filesystem.
    expect(carriesElidedArgsMarker({ file_path: buildElidedArgsInput(280).__elided_note })).toBe(true);
    // A paraphrase nested one level down in an argument slot.
    expect(carriesElidedArgsMarker({ file_path: LIVE_PARAPHRASED_MARKERS[0] })).toBe(true);
  });

  it("matches a note carried ALONGSIDE genuine arguments", () => {
    // For the VERBATIM marker this is pre-existing behaviour, not something the
    // widening introduces: the top-level prefix branch already fired whatever
    // else the object held. It is asserted here so nobody relaxes it by accident
    // while touching the key, because the answer must be the same for both
    // sentences — the note is proof the model is quoting compacted history
    // rather than deciding, so the call must not run even when it would
    // otherwise be well-formed. Adding an "only if it is the sole key" guard
    // would make a paraphrase runnable by padding it with one real argument.
    expect(carriesElidedArgsMarker({ file_path: "src/a.ts", ...buildElidedArgsInput(512) })).toBe(true);
    expect(carriesElidedArgsMarker({ file_path: "src/a.ts", ...LIVE_PARAPHRASED_MARKERS[1] })).toBe(true);
  });

  it("does NOT match a value that merely mentions elision under some other key", () => {
    // The widening is on the KEY. A different key holding prose about elision is
    // not the marker, however much of the vocabulary it borrows.
    expect(carriesElidedArgsMarker({ file_path: "src/a.ts", note: "earlier call args elided by the compactor" })).toBe(
      false,
    );
    expect(carriesElidedArgsMarker({ content: "the compactor elided earlier call args for this one" })).toBe(false);
    // An adjacent key is not the key. Its VALUE must not carry the prefix
    // either, or the argument-slot scan would (correctly) catch it and this
    // would stop pinning the key.
    expect(carriesElidedArgsMarker({ __elided_note_v2: "elided by the compactor, see earlier" })).toBe(false);
    // And the ordinary population stays ordinary.
    expect(carriesElidedArgsMarker({ file_path: "src/foo.ts" })).toBe(false);
    expect(carriesElidedArgsMarker({})).toBe(false);
    expect(carriesElidedArgsMarker(["__elided_note"])).toBe(false);
    expect(carriesElidedArgsMarker(undefined)).toBe(false);
    expect(carriesElidedArgsMarker("read src/a.ts")).toBe(false);
  });

  it("the prefix test answers a DIFFERENT question and must not widen with it", () => {
    // `isCompactorElisionMarker` asks "did THIS compactor write this?" — the
    // round-trip the idempotency guard needs to keep its own bytes stable. A
    // sentence the model invented was NOT written by the compactor, so it is
    // correctly false here while being correctly true above.
    for (const [i, input] of LIVE_PARAPHRASED_MARKERS.entries()) {
      expect(isCompactorElisionMarker(input), `live paraphrase ${i} is not compactor-written`).toBe(false);
    }
    expect(isCompactorElisionMarker(buildElidedArgsInput(4395))).toBe(true);
    expect(isCompactorElisionMarker(buildElidedArgsInput(4395).__elided_note)).toBe(true);
  });
});

describe("the arg guard's verdict for a paraphrased marker", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("refuses every live paraphrase as the MARKER class, and runs none of them", async () => {
    const call = livePipeline(tempDir(), "paraphrase-refusal");
    for (const [i, input] of LIVE_PARAPHRASED_MARKERS.entries()) {
      const step = await call("read_file", input);
      const text = outputText(step);
      // The non-negotiable: blocking is what bounds the damage. Terminating is a
      // separate concern and must never be bought by permitting the call.
      expect(text, `live paraphrase ${i}`).toContain("BLOCKED (");
      // THE POPULATION CHANGE, stated as an assertion: this used to be
      // `missing-required-args`.
      expect(text, `live paraphrase ${i}`).toContain("BLOCKED (elision-marker-as-args)");
      expect(text, `live paraphrase ${i}`).toContain("history-compaction marker");
      expect(text, `live paraphrase ${i}`).not.toContain("was called without usable arguments");
      // Nothing was read: no file content can appear in a refusal.
      expect(text, `live paraphrase ${i}`).not.toContain("export const v");
    }
  }, 60_000);

  it("still EXECUTES a well-formed call that merely mentions elision", async () => {
    const call = livePipeline(tempDir(), "paraphrase-nonmatch");
    // (a) a clean `file_path` beside a differently-keyed note about elision;
    const decoyArgs = await call("read_file", { file_path: `f7.ts`, note: "earlier call args elided by compactor" });
    expect(outputText(decoyArgs)).not.toContain("BLOCKED (");
    expect(outputText(decoyArgs)).toContain("export const v7");
    // (b) a file whose CONTENT contains the marker sentence. The predicate reads
    //     arguments, never results, so this must come back in full.
    const decoyFile = await call("read_file", { file_path: DECOY_FILE });
    expect(outputText(decoyFile)).not.toContain("BLOCKED (");
    expect(outputText(decoyFile)).toContain("is discussed here");
  }, 60_000);
});

describe("no-progress guard vs. a loop of paraphrased markers", () => {
  beforeEach(() => {
    (globalThis as { __muonroiMalformedArgStreak?: Map<string, number> }).__muonroiMalformedArgStreak = new Map();
  });

  it("ends a loop whose sentence is freshly invented on every step", async () => {
    const call = livePipeline(tempDir(), "paraphrase-bound");
    // Passed explicitly so the bound this test pins cannot be moved by
    // MUONROI_NO_PROGRESS_STEPS in the ambient environment.
    const limit = DEFAULT_NO_PROGRESS_STEPS;
    const guard = createNoProgressGuard(limit);
    const steps: Step[] = [];
    let stoppedAfter: number | null = null;

    for (let i = 0; i < limit * 6 && stoppedAfter === null; i++) {
      // Cycle the three live sentences AND stamp a fresh one, so `sha1(input)`
      // differs on every single step. That is what defeated the old predicate:
      // three distinct keys looked like three discoveries.
      const base = LIVE_PARAPHRASED_MARKERS[i % LIVE_PARAPHRASED_MARKERS.length] as Record<string, unknown>;
      const input = { __elided_note: `${String(base.__elided_note)} (#${i})` };
      const step = await call("read_file", input);
      expect(outputText(step), `step ${i + 1}`).toContain("BLOCKED (");
      steps.push(step);
      if (guard(steps)) stoppedAfter = steps.length;
    }

    // Before the widening this ran to exhaustion with the guard still false:
    // every invented sentence hashed differently, so the streak reset every
    // step. Now the class contributes no key at all, so the streak is the step
    // count and the loop ends at exactly `limit`.
    expect(stoppedAfter).not.toBeNull();
    expect(stoppedAfter).toBe(limit);
    expect(limit).toBe(6);
  }, 60_000);

  it("a step that also makes a genuinely new well-formed call is still progress", async () => {
    const call = livePipeline(tempDir(), "paraphrase-mixed");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // The property `f6738bb5` pins, held for the widened population too: a run
    // getting somewhere alongside a malformed call must not be killed.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      const blocked = await call("read_file", LIVE_PARAPHRASED_MARKERS[i % LIVE_PARAPHRASED_MARKERS.length]);
      const real = await call("read_file", { file_path: `f${i}.ts` });
      expect(outputText(blocked)).toContain("BLOCKED (elision-marker-as-args)");
      expect(outputText(real)).toContain(`export const v${i}`);
      steps.push({
        toolCalls: [...blocked.toolCalls, ...real.toolCalls],
        toolResults: [...blocked.toolResults, ...real.toolResults],
      });
      expect(guard(steps), `after ${steps.length} mixed steps`).toBe(false);
    }
  }, 60_000);

  it("a refused paraphrase repaired on the very next call never trips the guard", async () => {
    const call = livePipeline(tempDir(), "paraphrase-recover");
    const guard = createNoProgressGuard(DEFAULT_NO_PROGRESS_STEPS);
    const steps: Step[] = [];

    // This is the MEASURED pattern: all three live blocks were singletons
    // followed by real work (id 18777 at step 71 was followed by two successful
    // `read_file` results; id 26897 at step 40 by a successful `write_file`). A
    // recovering run must stay alive however long it runs.
    for (let i = 0; i < DEFAULT_NO_PROGRESS_STEPS * 3; i++) {
      steps.push(await call("read_file", LIVE_PARAPHRASED_MARKERS[i % LIVE_PARAPHRASED_MARKERS.length]));
      expect(guard(steps), `after block ${i + 1}`).toBe(false);
      steps.push(await call("read_file", { file_path: `f${i}.ts` }));
      expect(guard(steps), `after recovery ${i + 1}`).toBe(false);
    }
  }, 60_000);
});
